import type { FindSimilarInput, FindSimilarOutput, SearchEngine } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { BackendStatus } from '../server/backend-status.js';
import { findSimilar } from '../search/find-similar.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

const MAX_RESULTS_CAP = 50;

export async function handleFindSimilar(
  input: FindSimilarInput,
  engines: SearchEngine[],
  router: SmartRouter,
  backendStatus?: BackendStatus,
): Promise<FindSimilarOutput> {
  try {
    const url = input.url?.trim();
    const concept = input.concept?.trim();

    if (!url && !concept) {
      return {
        results: [],
        method: 'fts5',
        cache_hits: 0,
        search_hits: 0,
        embedding_available: false,
        error: 'Either url or concept must be provided',
        total_time_ms: 0,
      };
    }

    const sanitizedInput: FindSimilarInput = {
      ...input,
      max_results: input.max_results
        ? Math.min(input.max_results, MAX_RESULTS_CAP)
        : undefined,
    };

    log.info('find_similar request', {
      hasUrl: !!url,
      hasConcept: !!concept,
      maxResults: sanitizedInput.max_results,
      includeCache: sanitizedInput.include_cache,
      includeWeb: sanitizedInput.include_web,
    });

    return await findSimilar(sanitizedInput, engines, router, backendStatus);
  } catch (err) {
    log.error('handleFindSimilar failed', { error: String(err) });
    return {
      results: [],
      method: 'fts5',
      cache_hits: 0,
      search_hits: 0,
      embedding_available: false,
      error: `find_similar handler error: ${err instanceof Error ? err.message : String(err)}`,
      total_time_ms: 0,
    };
  }
}
