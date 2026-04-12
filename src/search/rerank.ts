import type { MergedSearchResult } from './dedup.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

export async function rerankResults(
  _query: string,
  results: MergedSearchResult[],
): Promise<MergedSearchResult[]> {
  log.debug('rerank passthrough (v1)', { count: results.length });
  return results;
}
