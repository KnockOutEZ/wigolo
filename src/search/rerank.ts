import type { MergedSearchResult } from './dedup.js';
import { onnxRerank } from './reranker/onnx.js';
import { applyRecencyBoost } from './reranker/recency-boost.js';
import { applyAuthorityBoost } from './reranker/authority-boost.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

export async function rerankResults(
  query: string,
  results: MergedSearchResult[],
  opts: { skip?: boolean } = {},
): Promise<MergedSearchResult[]> {
  if (opts.skip) return results;
  const config = getConfig();
  if (results.length === 0) return results;

  if (config.reranker === 'onnx') {
    try {
      const passages = results.map((r) => ({ text: `${r.title}\n${r.snippet}` }));
      const ranked = await onnxRerank(query, passages, { modelId: config.rerankerModel });
      const reordered = ranked.map((s) => ({ ...results[s.index], relevance_score: s.score }));
      const authorityBoosted = applyAuthorityBoost(query, reordered);
      const boosted = applyRecencyBoost(query, authorityBoosted);
      boosted.sort((a, b) => b.relevance_score - a.relevance_score);
      return applyThreshold(boosted, config.relevanceThreshold);
    } catch (err) {
      log.warn('ONNX rerank failed, falling back to passthrough', { error: String(err) });
    }
  } else if (config.reranker !== 'none') {
    log.warn('Unknown reranker configured, passing through', { reranker: config.reranker });
  }

  const authorityBoosted = applyAuthorityBoost(query, results);
  const boosted = applyRecencyBoost(query, authorityBoosted);
  boosted.sort((a, b) => b.relevance_score - a.relevance_score);
  return applyThreshold(boosted, config.relevanceThreshold);
}

function applyThreshold(
  results: MergedSearchResult[],
  threshold: number,
): MergedSearchResult[] {
  if (!threshold || threshold <= 0) return results;
  return results.filter((r) => r.relevance_score >= threshold);
}
