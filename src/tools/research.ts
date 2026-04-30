import { createLogger } from '../logger.js';
import { runResearchPipeline } from '../research/pipeline.js';
import {
  buildEvidenceFromMarkdown,
  applyTokenBudget,
} from '../search/evidence.js';
import type {
  EvidenceItem,
  ResearchInput,
  ResearchOutput,
  SearchEngine,
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
): Promise<ResearchOutput> {
  const start = Date.now();

  try {
    if (!input.question || typeof input.question !== 'string' || input.question.trim().length === 0) {
      return errorResult('question is required and must be a non-empty string', input, start);
    }

    if (input.depth && !VALID_DEPTHS.has(input.depth)) {
      return errorResult(
        `depth must be one of: quick, standard, comprehensive. Got: "${input.depth}"`,
        input,
        start,
      );
    }

    if (input.max_sources !== undefined) {
      if (typeof input.max_sources !== 'number' || input.max_sources < 1) {
        return errorResult('max_sources must be a positive number', input, start);
      }
      if (input.max_sources > MAX_SOURCES_LIMIT) {
        return errorResult(`max_sources must be at most ${MAX_SOURCES_LIMIT}`, input, start);
      }
    }

    log.info('research request received', {
      question: input.question.slice(0, 100),
      depth: input.depth ?? 'standard',
      max_sources: input.max_sources,
    });

    const out = await runResearchPipeline(input, engines, router, server);
    await attachEvidence(out, input);
    return out;
  } catch (err) {
    log.error('research handler failed', {
      question: input.question?.slice(0, 100),
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResult(
      err instanceof Error ? err.message : String(err),
      input,
      start,
    );
  }
}

async function attachEvidence(out: ResearchOutput, input: ResearchInput): Promise<void> {
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
  }
}

function errorResult(error: string, input: ResearchInput, start: number): ResearchOutput {
  return {
    report: '',
    citations: [],
    sources: [],
    sub_queries: [],
    depth: input.depth ?? 'standard',
    total_time_ms: Date.now() - start,
    sampling_supported: false,
    error,
  };
}
