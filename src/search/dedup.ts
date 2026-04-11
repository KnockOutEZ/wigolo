import { normalizeUrl } from '../cache/store.js';
import type { RawSearchResult } from '../types.js';

export interface MergedSearchResult {
  title: string;
  url: string;
  snippet: string;
  relevance_score: number;
  engines: string[];
}

export function deduplicateResults(results: RawSearchResult[]): MergedSearchResult[] {
  const urlMap = new Map<string, MergedSearchResult>();

  for (const result of results) {
    let normalized: string;
    try {
      normalized = normalizeUrl(result.url);
    } catch {
      normalized = result.url;
    }

    const existing = urlMap.get(normalized);

    if (existing) {
      if (result.relevance_score > existing.relevance_score) {
        existing.relevance_score = result.relevance_score;
        existing.title = result.title;
        existing.snippet = result.snippet;
      }
      if (!existing.engines.includes(result.engine)) {
        existing.engines.push(result.engine);
      }
    } else {
      urlMap.set(normalized, {
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        relevance_score: result.relevance_score,
        engines: [result.engine],
      });
    }
  }

  return [...urlMap.values()].sort((a, b) => b.relevance_score - a.relevance_score);
}
