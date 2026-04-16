import { createLogger } from '../logger.js';
import { runResearchPipeline } from '../research/pipeline.js';
import type { ResearchInput, ResearchOutput, SearchEngine } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { SamplingCapableServer } from '../search/sampling.js';

const log = createLogger('research');

const VALID_DEPTHS = new Set(['quick', 'standard', 'comprehensive']);
const MAX_SOURCES_LIMIT = 50;

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

    return await runResearchPipeline(input, engines, router, server);
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
