import { createLogger } from '../logger.js';
import { runAgentPipeline } from '../agent/pipeline.js';
import {
  buildEvidenceFromMarkdown,
  applyTokenBudget,
} from '../search/evidence.js';
import type {
  AgentInput,
  AgentOutput,
  EvidenceItem,
  SearchEngine,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { SamplingCapableServer } from '../search/sampling.js';

const log = createLogger('agent');

const MAX_PAGES_LIMIT = 100;
const MAX_TIME_LIMIT_MS = 600000;
const DEFAULT_MAX_TOKENS_OUT = 4000;

export async function handleAgent(
  input: AgentInput,
  engines: SearchEngine[],
  router: SmartRouter,
  _backendStatus?: unknown,
  server?: SamplingCapableServer,
): Promise<AgentOutput> {
  const start = Date.now();

  try {
    if (!input.prompt || typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
      return errorResult('prompt is required and must be a non-empty string', start);
    }

    if (input.max_pages !== undefined) {
      if (typeof input.max_pages !== 'number' || input.max_pages < 1) {
        return errorResult('max_pages must be a positive number', start);
      }
      if (input.max_pages > MAX_PAGES_LIMIT) {
        return errorResult(`max_pages must be at most ${MAX_PAGES_LIMIT}`, start);
      }
    }

    if (input.max_time_ms !== undefined) {
      if (typeof input.max_time_ms !== 'number' || input.max_time_ms < 1) {
        return errorResult('max_time_ms must be a positive number', start);
      }
      if (input.max_time_ms > MAX_TIME_LIMIT_MS) {
        return errorResult(`max_time_ms must be at most ${MAX_TIME_LIMIT_MS}`, start);
      }
    }

    if (input.urls && input.urls.length > 0) {
      for (const url of input.urls) {
        try {
          new URL(url);
        } catch {
          return errorResult(`Invalid url in urls array: "${url}"`, start);
        }
      }
    }

    log.info('agent request received', {
      prompt: input.prompt.slice(0, 100),
      max_pages: input.max_pages,
      max_time_ms: input.max_time_ms,
      urlCount: input.urls?.length ?? 0,
      hasSchema: !!input.schema,
    });

    const result = await runAgentPipeline(
      input,
      engines,
      router,
      server,
    );

    // Only populate evidence on the no-schema path; schema callers want the
    // structured object intact and not buried under prose excerpts.
    if (!input.schema) {
      await attachEvidence(result, input);
    }

    return result;
  } catch (err) {
    log.error('agent handler failed', {
      prompt: input.prompt?.slice(0, 100),
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResult(
      err instanceof Error ? err.message : String(err),
      start,
    );
  }
}

async function attachEvidence(out: AgentOutput, input: AgentInput): Promise<void> {
  if (out.sources.length === 0) return;
  const includeFull = input.include_full_markdown ?? false;
  const maxTokensOut = input.max_tokens_out ?? DEFAULT_MAX_TOKENS_OUT;

  const collected: EvidenceItem[] = [];
  for (const s of out.sources) {
    if (!s.markdown_content) continue;
    const evs = await buildEvidenceFromMarkdown(
      input.prompt,
      s.title,
      s.url,
      s.markdown_content,
      { maxItems: 1 },
    );
    collected.push(...evs);
  }

  const budgeted = applyTokenBudget(collected, maxTokensOut);
  if (budgeted.length > 0) out.evidence = budgeted;

  if (!includeFull) {
    for (const s of out.sources) {
      s.markdown_content = '';
    }
  }
}

function errorResult(error: string, start: number): AgentOutput {
  return {
    result: '',
    sources: [],
    pages_fetched: 0,
    steps: [],
    total_time_ms: Date.now() - start,
    sampling_supported: false,
    error,
  };
}
