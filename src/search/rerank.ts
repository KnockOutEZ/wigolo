import type { MergedSearchResult } from './dedup.js';
import { getRerankProvider } from '../providers/rerank-provider.js';
import { applyRecencyBoost } from './reranker/recency-boost.js';
import { applyAuthorityBoost } from './reranker/authority-boost.js';
import { applyConsensusBoost } from './reranker/consensus-boost.js';
import { rerankInputText } from './core/rerank-fold.js';
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
      const provider = await getRerankProvider();
      const candidates = results.map((r, i) => ({
        id: String(i),
        text: rerankInputText(r.title, r.snippet, r.url),
      }));
      const ranked = await provider.rerank(query, candidates);
      const reordered = ranked.map((s) => ({
        ...results[Number(s.id)],
        relevance_score: s.score,
      }));
      const consensusBoosted = applyConsensusBoost(reordered);
      const authorityBoosted = applyAuthorityBoost(query, consensusBoosted);
      const boosted = applyRecencyBoost(query, authorityBoosted);
      boosted.sort((a, b) => b.relevance_score - a.relevance_score);
      return applyThreshold(boosted, config.relevanceThreshold);
    } catch (err) {
      log.warn('Rerank failed, falling back to passthrough', { error: String(err) });
    }
  } else if (config.reranker !== 'none') {
    log.warn('Unknown reranker configured, passing through', { reranker: config.reranker });
  }

  const consensusBoosted = applyConsensusBoost(results);
  const authorityBoosted = applyAuthorityBoost(query, consensusBoosted);
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
