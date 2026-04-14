import { createLogger } from '../logger.js';

const log = createLogger('search');

/**
 * Reciprocal Rank Fusion -- merges multiple ranked lists into a single
 * score map. Each list maps URL -> rank (1-based). The fused score for
 * a URL is the sum of 1/(k + rank) across all lists it appears in.
 */
export function reciprocalRankFusion(
  lists: Map<string, number>[],
  k: number = 60,
): Map<string, number> {
  try {
    const scores = new Map<string, number>();

    for (const list of lists) {
      for (const [url, rank] of list) {
        const contribution = 1 / (k + rank);
        scores.set(url, (scores.get(url) ?? 0) + contribution);
      }
    }

    log.debug('RRF fusion complete', {
      inputLists: lists.length,
      uniqueUrls: scores.size,
    });

    return scores;
  } catch (err) {
    log.error('RRF fusion failed', { error: String(err) });
    return new Map();
  }
}

/**
 * Convert a fused score map into a sorted array of [url, score] pairs,
 * descending by score.
 */
export function sortByRRFScore(
  scores: Map<string, number>,
): Array<[string, number]> {
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Build a rank map from an ordered array of URLs.
 * First URL gets rank 1, second gets rank 2, etc.
 */
export function buildRankMap(urls: string[]): Map<string, number> {
  const rankMap = new Map<string, number>();
  for (let i = 0; i < urls.length; i++) {
    if (!rankMap.has(urls[i])) {
      rankMap.set(urls[i], i + 1);
    }
  }
  return rankMap;
}
