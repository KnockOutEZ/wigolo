import { createLogger } from '../logger.js';
import { runAgentPipeline } from '../agent/pipeline.js';
import {
  buildEvidenceFromMarkdown,
  applyTokenBudget,
  applyAggregateMarkdownBudget,
} from '../search/evidence.js';
import { applyOutputBudget } from '../search/truncate.js';
import { countTokens } from '../search/tokens.js';
import type {
  AgentInput,
  AgentOutput,
  EvidenceItem,
  SearchEngine,
  StageResult,
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
): Promise<StageResult<AgentOutput>> {
  try {
    if (!input.prompt || typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
      return invalidInput('prompt is required and must be a non-empty string');
    }

    if (input.max_pages !== undefined) {
      if (typeof input.max_pages !== 'number' || input.max_pages < 1) {
        return invalidInput('max_pages must be a positive number');
      }
      if (input.max_pages > MAX_PAGES_LIMIT) {
        return invalidInput(`max_pages must be at most ${MAX_PAGES_LIMIT}`);
      }
    }

    if (input.max_time_ms !== undefined) {
      if (typeof input.max_time_ms !== 'number' || input.max_time_ms < 1) {
        return invalidInput('max_time_ms must be a positive number');
      }
      if (input.max_time_ms > MAX_TIME_LIMIT_MS) {
        return invalidInput(`max_time_ms must be at most ${MAX_TIME_LIMIT_MS}`);
      }
    }

    if (input.urls && input.urls.length > 0) {
      for (const url of input.urls) {
        try {
          new URL(url);
        } catch {
          return invalidInput(`Invalid url in urls array: "${url}"`);
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

    const _start = Date.now();
    const result = await runAgentPipeline(
      input,
      engines,
      router,
      server,
    );
    result.response_time_ms = Date.now() - _start;

    // Only populate evidence on the no-schema path; schema callers want the
    // structured object intact and not buried under prose excerpts.
    if (!input.schema) {
      await attachEvidence(result, input);
      // Cap result text under the same budget. Schema results are left intact.
      if (input.max_tokens_out !== undefined && typeof result.result === 'string' && result.result) {
        result.result = applyOutputBudget(result.result, { maxTokensOut: input.max_tokens_out });
      }
      // Holistic envelope: result + sources + evidence + steps must all live
      // inside max_tokens_out so the agent tool honours the caller's budget
      // for the FULL response, not just the `result` string.
      if (input.max_tokens_out !== undefined) {
        enforceResponseEnvelope(result, input.max_tokens_out);
      }
    }

    if (result.error) {
      return {
        ok: false,
        error: result.error,
        error_reason: result.error,
        stage: 'agent',
      };
    }
    return { ok: true, data: result };
  } catch (err) {
    log.error('agent handler failed', {
      prompt: input.prompt?.slice(0, 100),
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: 'agent_failed',
      error_reason: err instanceof Error ? err.message : String(err),
      stage: 'agent',
    };
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
  } else {
    applyAggregateMarkdownBudget(
      out.sources,
      (s) => s.markdown_content ?? '',
      (s, body) => { s.markdown_content = body; },
      { maxTokensOut },
    );
  }
}

// Trim the AgentOutput in-place so the stringified response stays under
// `maxTokensOut`. Order:
//   1. Drop tail evidence (least synthesis value once `result` exists).
//   2. Drop tail sources (URLs + titles; markdown_content already trimmed).
//   3. Tighten the `result` cap aggressively as a last resort.
// Steps[] and timings are preserved so callers retain observability.
function enforceResponseEnvelope(out: AgentOutput, maxTokensOut: number): void {
  const measure = () => countTokens(JSON.stringify(out));

  if (measure() <= maxTokensOut) return;

  if (out.evidence && out.evidence.length > 0) {
    while (out.evidence.length > 0 && measure() > maxTokensOut) {
      out.evidence.pop();
    }
    if (out.evidence.length === 0) delete (out as { evidence?: EvidenceItem[] }).evidence;
  }

  if (measure() <= maxTokensOut) return;

  while (out.sources.length > 0 && measure() > maxTokensOut) {
    out.sources.pop();
  }

  if (measure() <= maxTokensOut) return;

  if (typeof out.result === 'string' && out.result.length > 0) {
    // Allow shrinking room equal to the current overshoot from `result`.
    const overshoot = measure() - maxTokensOut;
    const currentTokens = countTokens(out.result);
    const target = Math.max(0, currentTokens - overshoot - 20);
    out.result = applyOutputBudget(out.result, { maxTokensOut: target });
  }
}

function invalidInput(error_reason: string): StageResult<AgentOutput> {
  return {
    ok: false,
    error: 'invalid_input',
    error_reason,
    stage: 'agent',
  };
}
