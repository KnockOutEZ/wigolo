import type { MergedSearchResult } from '../dedup.js';
import { hasRecencyIntent, recencyFactor } from './recency.js';

export function applyRecencyBoost(
  query: string,
  results: MergedSearchResult[],
  now: Date = new Date(),
): MergedSearchResult[] {
  if (!hasRecencyIntent(query, now)) return results;
  return results.map((r) => {
    const factor = recencyFactor(r.published_date, now);
    if (factor === 1.0) return r;
    return { ...r, relevance_score: r.relevance_score * factor };
  });
}
