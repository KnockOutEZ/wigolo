import type { RawSearchResult, SearchEngine, SearchEngineOptions } from '../types.js';
import type { MergedSearchResult } from './dedup.js';
import { normalizeUrl } from '../cache/store.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

const RRF_K = 60;

export function normalizeQueries(queries: string[]): string[] {
  try {
    const config = getConfig();
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const raw of queries) {
      const q = raw.toLowerCase().trim().replace(/\s+/g, ' ');
      if (q.length === 0) continue;
      if (seen.has(q)) continue;
      seen.add(q);
      normalized.push(q);
    }

    if (normalized.length > config.multiQueryMax) {
      log.warn('multi-query array exceeds max, truncating', {
        provided: normalized.length,
        max: config.multiQueryMax,
      });
      return normalized.slice(0, config.multiQueryMax);
    }

    return normalized;
  } catch (err) {
    log.error('normalizeQueries failed', { error: String(err) });
    return [];
  }
}

export interface FanOutOptions {
  maxResults: number;
  timeRange?: string;
  language?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  fromDate?: string;
  toDate?: string;
  category?: 'general' | 'news' | 'code' | 'docs' | 'papers' | 'images';
}

export interface FanOutResult {
  results: RawSearchResult[];
  enginesUsed: string[];
  errors: string[];
}

export async function fanOutSearch(
  queries: string[],
  engines: SearchEngine[],
  options: FanOutOptions,
): Promise<FanOutResult> {
  const allResults: RawSearchResult[] = [];
  const enginesUsed = new Set<string>();
  const errors: string[] = [];

  if (queries.length === 0 || engines.length === 0) {
    return { results: [], enginesUsed: [], errors: [] };
  }

  try {
    const config = getConfig();
    const concurrency = config.multiQueryConcurrency;

    const hasFilterAttrition = !!(options.includeDomains?.length || options.excludeDomains?.length);
    const overfetchFactor = hasFilterAttrition ? 3 : 2;

    const engineOptions: SearchEngineOptions = {
      maxResults: options.maxResults * overfetchFactor,
      timeRange: options.timeRange,
      language: options.language,
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
      fromDate: options.fromDate,
      toDate: options.toDate,
      category: options.category,
    };

    const tasks: Array<{ engine: SearchEngine; query: string }> = [];
    for (const engine of engines) {
      for (const query of queries) {
        tasks.push({ engine, query });
      }
    }

    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      const promises = batch.map(async ({ engine, query }) => {
        try {
          const results = await engine.search(query, engineOptions);
          for (const r of results) {
            allResults.push(r);
            enginesUsed.add(engine.name);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('multi-query engine search failed', {
            engine: engine.name,
            query,
            error: msg,
          });
          errors.push(`${engine.name}(${query}): ${msg}`);
        }
      });

      await Promise.allSettled(promises);
    }

    return {
      results: allResults,
      enginesUsed: [...enginesUsed],
      errors,
    };
  } catch (err) {
    log.error('fanOutSearch failed', { error: String(err) });
    return {
      results: allResults,
      enginesUsed: [...enginesUsed],
      errors: [...errors, `fanOutSearch: ${String(err)}`],
    };
  }
}

export function synthesizeIntent(queries: string[]): string {
  try {
    return queries.map(q => q.trim()).filter(Boolean).join('; ');
  } catch (err) {
    log.error('synthesizeIntent failed', { error: String(err) });
    return '';
  }
}

export function mergeWithRRF(rankedLists: MergedSearchResult[][]): MergedSearchResult[] {
  try {
    if (rankedLists.length === 0) return [];

    const nonEmpty = rankedLists.filter(l => l.length > 0);
    if (nonEmpty.length === 0) return [];

    const rrfScores = new Map<string, number>();
    const bestAppearance = new Map<string, { result: MergedSearchResult; bestRank: number }>();

    for (const list of nonEmpty) {
      for (let rank = 0; rank < list.length; rank++) {
        const item = list[rank];
        let normalizedUrlStr: string;
        try {
          normalizedUrlStr = normalizeUrl(item.url);
        } catch {
          normalizedUrlStr = item.url;
        }

        const rrfContribution = 1 / (RRF_K + rank + 1);
        const current = rrfScores.get(normalizedUrlStr) ?? 0;
        rrfScores.set(normalizedUrlStr, current + rrfContribution);

        const existing = bestAppearance.get(normalizedUrlStr);
        if (!existing || rank < existing.bestRank) {
          bestAppearance.set(normalizedUrlStr, { result: item, bestRank: rank });
        }
      }
    }

    let maxScore = 0;
    for (const score of rrfScores.values()) {
      if (score > maxScore) maxScore = score;
    }

    const merged: MergedSearchResult[] = [];
    for (const [normalizedUrlStr, score] of rrfScores.entries()) {
      const appearance = bestAppearance.get(normalizedUrlStr)!;
      merged.push({
        ...appearance.result,
        relevance_score: maxScore > 0 ? score / maxScore : 0,
      });
    }

    merged.sort((a, b) => b.relevance_score - a.relevance_score);
    return merged;
  } catch (err) {
    log.error('mergeWithRRF failed', { error: String(err) });
    return [];
  }
}
