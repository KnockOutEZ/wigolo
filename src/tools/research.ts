import { createLogger } from '../logger.js';
import { runResearchPipeline } from '../research/pipeline.js';
import {
  buildEvidenceFromMarkdown,
  applyTokenBudget,
  applyAggregateMarkdownBudget,
} from '../search/evidence.js';
import { applyOutputBudget } from '../search/truncate.js';
import type {
  EvidenceItem,
  ResearchInput,
  ResearchOutput,
  SearchEngine,
  StageResult,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { SamplingCapableServer } from '../search/sampling.js';

const log = createLogger('research');

const VALID_DEPTHS = new Set(['quick', 'standard', 'comprehensive']);
const MAX_SOURCES_LIMIT = 50;
const DEFAULT_MAX_TOKENS_OUT = 4000;

export async function handleResearch(
  input: ResearchInput,
  engines: SearchEngine[],
  router: SmartRouter,
  _backendStatus?: unknown,
  server?: SamplingCapableServer,
): Promise<StageResult<ResearchOutput>> {
  try {
    if (!input.question || typeof input.question !== 'string' || input.question.trim().length === 0) {
      return invalidInput('question is required and must be a non-empty string');
    }

    if (input.depth && !VALID_DEPTHS.has(input.depth)) {
      return invalidInput(
        `depth must be one of: quick, standard, comprehensive. Got: "${input.depth}"`,
      );
    }

    if (input.max_sources !== undefined) {
      if (typeof input.max_sources !== 'number' || input.max_sources < 1) {
        return invalidInput('max_sources must be a positive number');
      }
      if (input.max_sources > MAX_SOURCES_LIMIT) {
        return invalidInput(`max_sources must be at most ${MAX_SOURCES_LIMIT}`);
      }
    }

    log.info('research request received', {
      question: input.question.slice(0, 100),
      depth: input.depth ?? 'standard',
      max_sources: input.max_sources,
    });

    const _start = Date.now();
    const out = await runResearchPipeline(input, engines, router, server);
    await attachEvidence(out, input);
    out.response_time_ms = Date.now() - _start;
    if (out.error) {
      return {
        ok: false,
        error: out.error,
        error_reason: out.error,
        stage: 'research',
      };
    }
    return { ok: true, data: out };
  } catch (err) {
    log.error('research handler failed', {
      question: input.question?.slice(0, 100),
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: 'research_failed',
      error_reason: err instanceof Error ? err.message : String(err),
      stage: 'research',
    };
  }
}

async function attachEvidence(out: ResearchOutput, input: ResearchInput): Promise<void> {
  // Always honour max_tokens_out for the report text, regardless of sources.
  if (input.max_tokens_out !== undefined && out.report) {
    out.report = applyOutputBudget(out.report, { maxTokensOut: input.max_tokens_out });
  }

  if (out.sources.length === 0) return;
  const includeFull = input.include_full_markdown ?? false;
  const maxTokensOut = input.max_tokens_out ?? DEFAULT_MAX_TOKENS_OUT;

  const collected: EvidenceItem[] = [];
  for (const s of out.sources) {
    if (!s.markdown_content) continue;
    const evs = await buildEvidenceFromMarkdown(
      input.question,
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

function invalidInput(error_reason: string): StageResult<ResearchOutput> {
  return {
    ok: false,
    error: 'invalid_input',
    error_reason,
    stage: 'research',
  };
}
