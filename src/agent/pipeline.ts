import { createLogger } from '../logger.js';
import { planExecution } from './planner.js';
import { executeAgentPlan } from './executor.js';
import { extractWithSchema } from '../extraction/schema.js';
import {
  type SamplingCapableServer,
  requestSampling,
  checkSamplingSupport,
} from '../search/sampling.js';
import { isLlmConfiguredWithKeyStore, runLlmText } from '../integrations/cloud/llm/run.js';
import type {
  AgentInput,
  AgentOutput,
  AgentSource,
  AgentStep,
  SearchEngine,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { JsonSchema } from '../extraction/schema.js';

const log = createLogger('agent');

// tight default to keep agent responses under token caps. 10 pages was
// blowing budgets on long runs; 3 reads enough for synthesis on most prompts
// while letting callers opt in to more via input.max_pages.
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_TIME_MS = 60000;

// Test-only accessor — keeps the constant out of the public surface while
// letting unit tests pin the value.
export function getAgentDefaultMaxPages(): number {
  return DEFAULT_MAX_PAGES;
}

export async function runAgentPipeline(
  input: AgentInput,
  engines: SearchEngine[],
  router: SmartRouter,
  server?: SamplingCapableServer,
): Promise<AgentOutput> {
  const start = Date.now();
  const maxPages = input.max_pages ?? DEFAULT_MAX_PAGES;
  const maxTimeMs = input.max_time_ms ?? DEFAULT_MAX_TIME_MS;
  const deadlineMs = start + maxTimeMs;
  const steps: AgentStep[] = [];

  try {
    const planStart = Date.now();
    log.info('agent pipeline started', { prompt: input.prompt.slice(0, 100), maxPages, maxTimeMs });

    const plan = await planExecution(input.prompt, input.urls, server);

    steps.push({
      action: 'plan',
      detail: `Generated ${plan.searches.length} searches, ${plan.urls.length} URLs${plan.samplingUsed ? ' (via sampling)' : ' (keyword extraction)'}`,
      time_ms: Date.now() - planStart,
    });

    log.info('plan generated', {
      searches: plan.searches.length,
      urls: plan.urls.length,
      samplingUsed: plan.samplingUsed,
    });

    const execResult = await executeAgentPlan(plan, engines, router, {
      maxPages,
      deadlineMs,
    }, input.prompt);

    steps.push(...execResult.steps);

    const sources = execResult.sources;
    const pagesFetched = sources.filter((s) => s.fetched).length;

    // When the caller passes a schema, attempt structured extraction even if
    // no sources fetched — emit an explicit warning when we can't honor it
    // instead of silently falling through to free-text synthesis (the bench
    // called this "agent.schema silently ignored").
    let schemaWarning: string | undefined;
    if (input.schema) {
      const fetchedCount = sources.filter((s) => s.fetched).length;
      if (fetchedCount === 0) {
        schemaWarning = `schema requested but no sources could be fetched — returning free-text result instead of structured data`;
      } else {
        const extractStart = Date.now();
        const schemaResult = applySchemaExtraction(sources, input.schema as JsonSchema);

        steps.push({
          action: 'extract',
          detail: `Applied schema extraction to ${fetchedCount} sources`,
          time_ms: Date.now() - extractStart,
        });

        if (schemaResult) {
          return {
            result: schemaResult,
            sources,
            pages_fetched: pagesFetched,
            steps,
            total_time_ms: Date.now() - start,
            sampling_supported: !!server && checkSamplingSupport(server),
          };
        }

        schemaWarning = `schema extraction returned no matching fields from ${fetchedCount} fetched sources — falling back to free-text synthesis`;
      }
    }

    const synthStart = Date.now();
    const { result, samplingUsed, llmUsed } = await synthesizeResult(
      input.prompt,
      sources,
      server,
    );

    const resultLen = typeof result === 'string' ? result.length : JSON.stringify(result).length;
    const synthPath = samplingUsed
      ? ' (via sampling)'
      : llmUsed
        ? ' (via configured LLM)'
        : ' (evidence fallback)';
    steps.push({
      action: 'synthesize',
      detail: `Produced ${resultLen} char result${synthPath}`,
      time_ms: Date.now() - synthStart,
    });

    // When every fetch failed but the planner produced URLs,
    // surface that as a partial-fail warning so callers don't see "No data
    // could be gathered" with zero context. The synthesis text already
    // mentions the attempt count; the warning gives clients a structured
    // pivot point for retry / broadening logic.
    const partialFailWarning =
      sources.length > 0 && pagesFetched === 0
        ? `fetch failed for all ${sources.length} candidate page(s); no content available for synthesis`
        : undefined;

    return {
      result,
      sources,
      pages_fetched: pagesFetched,
      steps,
      total_time_ms: Date.now() - start,
      sampling_supported: !!server && checkSamplingSupport(server),
      ...(schemaWarning ? { warning: schemaWarning } : partialFailWarning ? { warning: partialFailWarning } : {}),
    };
  } catch (err) {
    log.error('agent pipeline failed', {
      prompt: input.prompt.slice(0, 100),
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      result: '',
      sources: [],
      pages_fetched: 0,
      steps,
      total_time_ms: Date.now() - start,
      sampling_supported: !!server && checkSamplingSupport(server),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function applySchemaExtraction(
  sources: AgentSource[],
  schema: JsonSchema,
): Record<string, unknown> | null {
  try {
    const fetchedSources = sources.filter((s) => s.fetched && s.markdown_content.length > 0);
    if (fetchedSources.length === 0) return null;

    const mergedData: Record<string, unknown> = {};

    for (const source of fetchedSources) {
      try {
        const html = `<html><body>${source.markdown_content}</body></html>`;
        const extracted = extractWithSchema(html, schema);

        for (const [key, value] of Object.entries(extracted)) {
          if (value !== undefined && value !== null && value !== '') {
            if (!(key in mergedData)) {
              mergedData[key] = value;
            }
          }
        }
      } catch (err) {
        log.debug('schema extraction failed for source', {
          url: source.url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return Object.keys(mergedData).length > 0 ? mergedData : null;
  } catch (err) {
    log.warn('schema extraction phase failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function synthesizeResult(
  prompt: string,
  sources: AgentSource[],
  server?: SamplingCapableServer,
): Promise<{ result: string; samplingUsed: boolean; llmUsed?: boolean }> {
  const fetchedSources = sources.filter((s) => s.fetched && s.markdown_content.length > 0);

  if (fetchedSources.length === 0) {
    // Never claim "no data" when the planner did surface
    // candidate URLs. Name the attempt count so callers can tell apart
    // "fetches all failed" from "search returned nothing" — both shapes
    // used to collapse to the same blank message.
    if (sources.length > 0) {
      const failed = sources.filter((s) => !s.fetched).length;
      const reasonSnippets = sources
        .map((s) => s.fetch_error)
        .filter((e): e is string => typeof e === 'string' && e.length > 0)
        .slice(0, 3);
      const reasonClause = reasonSnippets.length > 0
        ? ` (e.g. ${reasonSnippets.join('; ')})`
        : '';
      return {
        result: `Attempted ${sources.length} page(s) but ${failed} fetch(es) failed${reasonClause}. 0 of ${sources.length} pages yielded content — try again with a broader query, different URLs, or check upstream availability.`,
        samplingUsed: false,
      };
    }
    return { result: 'No data could be gathered for this request.', samplingUsed: false };
  }

  // Prefer the operator's explicit LLM provider over host-provided sampling so
  // agent matches the research + search/format=answer contract — one wired
  // backend drives synthesis across every Gemini-capable tool. Keystore-aware
  // so keychain/file keys (zero-env init) are recognized, not just env vars.
  if (await isLlmConfiguredWithKeyStore()) {
    try {
      const result = await synthesizeViaLlmRunner(prompt, fetchedSources);
      if (result) return { result, samplingUsed: false, llmUsed: true };
    } catch (err) {
      log.warn('llm runner synthesis failed, falling through to sampling', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (server) {
    try {
      const result = await synthesizeWithSampling(prompt, fetchedSources, server);
      if (result) return { result, samplingUsed: true };
    } catch (err) {
      log.warn('sampling synthesis failed, using evidence fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { result: buildFallbackSynthesis(prompt, fetchedSources), samplingUsed: false };
}

async function synthesizeViaLlmRunner(
  prompt: string,
  sources: AgentSource[],
): Promise<string | null> {
  const maxCharsPerSource = 3000;
  const sourceBlocks = sources.map((s, i) => {
    const content = s.markdown_content.slice(0, maxCharsPerSource);
    return `[${i + 1}] ${s.title} (${s.url})\n${content}`;
  });
  const truncated = sourceBlocks.join('\n\n').slice(0, 40000);
  const fullPrompt =
    'You are a data gathering assistant. Based on the user request and the gathered sources, ' +
    'synthesize a clear, well-organized response. Cite sources as [1], [2], etc.\n\n' +
    `User request: ${prompt}\n\n` +
    `Sources:\n${truncated}`;
  const r = await runLlmText({ prompt: fullPrompt, maxTokens: 2000 });
  return r.text && r.text.trim().length > 0 ? r.text.trim() : null;
}

async function synthesizeWithSampling(
  prompt: string,
  sources: AgentSource[],
  server: SamplingCapableServer,
): Promise<string | null> {
  try {
    const maxCharsPerSource = 3000;
    const sourceBlocks = sources.map((s, i) => {
      const content = s.markdown_content.slice(0, maxCharsPerSource);
      return `[${i + 1}] ${s.title} (${s.url})\n${content}`;
    });

    const totalSourceText = sourceBlocks.join('\n\n');
    const truncatedSourceText = totalSourceText.slice(0, 40000);

    const samplingPrompt = `You are a data gathering assistant. Based on the user's request and the gathered sources, synthesize a comprehensive result.

User's request: ${prompt}

Gathered sources:
${truncatedSourceText}

Provide a clear, well-organized response that addresses the user's request based on the gathered data. Include source references [1], [2], etc.`;

    if (!checkSamplingSupport(server)) {
      log.debug('client does not support sampling for synthesis');
      return null;
    }

    const response = await requestSampling(
      server,
      [{ role: 'user', content: { type: 'text', text: samplingPrompt } }],
      2000,
    );

    if (response?.content?.text && response.content.text.trim().length > 0) {
      return response.content.text.trim();
    }

    return null;
  } catch (err) {
    log.debug('sampling synthesis failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function buildFallbackSynthesis(prompt: string, sources: AgentSource[]): string {
  const header = `## Results: ${prompt}\n\nGathered from ${sources.length} source(s):\n\n`;
  let result = header;
  const maxTotal = 6000;
  let remaining = maxTotal - header.length;

  for (let i = 0; i < sources.length && remaining > 0; i++) {
    const source = sources[i];
    const sourceHeader = `### [${i + 1}] ${source.title}\n**URL:** ${source.url}\n\n`;

    if (remaining < sourceHeader.length + 20) break;

    result += sourceHeader;
    remaining -= sourceHeader.length;

    const contentBudget = Math.min(remaining - 10, source.markdown_content.length, 1500);
    if (contentBudget > 0) {
      let content = source.markdown_content.slice(0, contentBudget);
      if (content.length < source.markdown_content.length) {
        content = content.slice(0, Math.max(contentBudget - 3, 0)) + '...';
      }
      result += content + '\n\n';
      remaining -= content.length + 2;
    }
  }

  return result.trimEnd();
}
