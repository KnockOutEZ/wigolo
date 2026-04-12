import type { MergedSearchResult } from './dedup.js';
import { flashRankRerank, isFlashRankAvailable } from './flashrank.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

export async function rerankResults(
  query: string,
  results: MergedSearchResult[],
): Promise<MergedSearchResult[]> {
  const config = getConfig() as any;

  if (results.length === 0) return results;

  if (config.reranker === 'flashrank') {
    if (await isFlashRankAvailable()) {
      const passages = results.map((r, i) => ({
        text: `${r.title}\n${r.snippet}`,
        index: i,
      }));

      const ranked = await flashRankRerank(query, passages);
      if (ranked) {
        const reordered = ranked.map((r) => ({
          ...results[r.index],
          relevance_score: r.score,
        }));

        return applyThreshold(reordered, config.relevanceThreshold);
      }

      log.debug('FlashRank returned null, using passthrough');
    } else {
      log.warn('FlashRank configured but not installed. Run: wigolo warmup --reranker');
    }
  } else if (config.reranker !== 'none') {
    log.warn('Unknown reranker configured, passing through', { reranker: config.reranker });
  }

  log.debug('Rerank passthrough', { count: results.length });
  return applyThreshold(results, config.relevanceThreshold);
}

function applyThreshold(
  results: MergedSearchResult[],
  threshold: number,
): MergedSearchResult[] {
  if (!threshold || threshold <= 0) return results;
  return results.filter((r) => r.relevance_score >= threshold);
}
