import type { MergedSearchResult } from './dedup.js';
import { flashRankRerank, isFlashRankAvailable } from './flashrank.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

export async function rerankResults(
  query: string,
  results: MergedSearchResult[],
): Promise<MergedSearchResult[]> {
  const config = getConfig();

  if (results.length === 0) return results;

  if (config.reranker === 'flashrank') {
    if (await isFlashRankAvailable()) {
      const passages = results.map((r, i) => ({
        text: `${r.title}\n${r.snippet}`,
        index: i,
      }));

      const ranked = await flashRankRerank(query, passages, config.rerankerModel);
      if (ranked) {
        const reordered = ranked.map((r) => ({
          ...results[r.index],
          relevance_score: r.score,
        }));

        const boosted = applyRecencyBoost(reordered);
        boosted.sort((a, b) => b.relevance_score - a.relevance_score);
        return applyThreshold(boosted, config.relevanceThreshold);
      }

      log.debug('FlashRank returned null, using passthrough');
    } else {
      log.warn('FlashRank configured but not installed. Run: wigolo warmup --reranker');
    }
  } else if (config.reranker !== 'none') {
    log.warn('Unknown reranker configured, passing through', { reranker: config.reranker });
  }

  log.debug('Rerank passthrough', { count: results.length });
  const boosted = applyRecencyBoost(results);
  boosted.sort((a, b) => b.relevance_score - a.relevance_score);
  return applyThreshold(boosted, config.relevanceThreshold);
}

export function applyRecencyBoost(results: MergedSearchResult[]): MergedSearchResult[] {
  const now = Date.now();
  return results.map(r => {
    if (!r.published_date) return r;

    const ts = new Date(r.published_date).getTime();
    if (isNaN(ts)) return r;

    const ageDays = (now - ts) / (1000 * 60 * 60 * 24);

    let boost = 1.0;
    if (ageDays < 7) boost = 1.2;
    else if (ageDays < 30) boost = 1.1;
    else if (ageDays < 90) boost = 1.05;

    if (boost === 1.0) return r;
    return { ...r, relevance_score: r.relevance_score * boost };
  });
}

function applyThreshold(
  results: MergedSearchResult[],
  threshold: number,
): MergedSearchResult[] {
  if (!threshold || threshold <= 0) return results;
  return results.filter((r) => r.relevance_score >= threshold);
}
