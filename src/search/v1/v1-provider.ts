// V1SearchProvider — Phase 7 retrieval-only adapter.
//
// Delegates to the v1 orchestrator (intent routing + per-vertical engines +
// RRF fusion) and maps RawSearchResult to SearchResultItem for the MCP
// `search` tool surface. Array queries dispatch in parallel and are RRF-fused
// across dispatches so callers can hedge phrasings without paying serial cost.

import type { SearchProvider, SearchContext } from '../../providers/search-provider.js';
import type {
  RawSearchResult,
  SearchInput,
  SearchOutput,
  SearchResultItem,
  StageResult,
} from '../../types.js';
import { runV1Search } from './orchestrator.js';
import { applyContextRank } from './context-rank.js';
import { dedupAgainstRecentUrls } from './recent-cache-dedup.js';

const RRF_K = 60;

function normalizeArrayQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of queries) {
    if (typeof raw !== 'string') continue;
    const q = raw.trim();
    if (q.length === 0) continue;
    const key = q.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

function fuseRankedLists(lists: RawSearchResult[][]): RawSearchResult[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, RawSearchResult>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const prev = scores.get(r.url) ?? 0;
      scores.set(r.url, prev + 1 / (RRF_K + rank + 1));
      if (!firstSeen.has(r.url)) firstSeen.set(r.url, r);
    }
  }
  const maxScore = Math.max(0, ...scores.values());
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url, score]) => {
      const base = firstSeen.get(url);
      if (!base) return undefined;
      return {
        ...base,
        relevance_score: maxScore > 0 ? score / maxScore : 0,
      };
    })
    .filter((r): r is RawSearchResult => r !== undefined);
}

export class V1SearchProvider implements SearchProvider {
  readonly name = 'v1' as const;

  async search(input: SearchInput, _ctx: SearchContext): Promise<StageResult<SearchOutput>> {
    const isArray = Array.isArray(input.query);
    const queries = isArray
      ? normalizeArrayQueries(input.query as string[])
      : typeof input.query === 'string' && input.query.trim() !== ''
        ? [input.query.trim()]
        : [];

    if (queries.length === 0) {
      return {
        ok: false,
        error: 'invalid_input',
        error_reason: 'Query is empty',
        stage: 'search',
      };
    }

    if (input.category === 'images') {
      return {
        ok: false,
        error: 'unsupported_category',
        error_reason: 'images vertical not supported in v1 — set WIGOLO_SEARCH=searxng for legacy image search, or omit category for a general search',
        stage: 'search',
      };
    }
    const category = input.category;

    const start = Date.now();
    const dispatches = await Promise.all(
      queries.map((q) =>
        runV1Search({
          query: q,
          category,
          fromDate: input.from_date,
          toDate: input.to_date,
          maxResults: input.max_results,
          language: input.language,
          includeDomains: input.include_domains,
          excludeDomains: input.exclude_domains,
        }),
      ),
    );

    const fused =
      dispatches.length === 1
        ? dispatches[0].results
        : fuseRankedLists(dispatches.map((d) => d.results));

    const enginesUsedSet = new Set<string>();
    for (const d of dispatches) {
      for (const e of d.enginesUsed) enginesUsedSet.add(e);
    }
    const enginesUsed = [...enginesUsedSet];

    const allDegraded = dispatches.every((d) => d.degraded);

    // Display query is the first input string (back-compat) so consumers can
    // still echo what was asked; arrays just join with " | " for clarity.
    const displayQuery = isArray ? (input.query as string[]).filter(Boolean).join(' | ') : queries[0];

    let processed = fused;

    if (input.agent_context?.text || input.agent_context?.intent) {
      const contextText = input.agent_context.text ?? input.agent_context.intent;
      processed = await applyContextRank(processed, queries[0], contextText);
    }

    if (input.agent_context?.recent_urls?.length) {
      processed = dedupAgainstRecentUrls(processed, input.agent_context.recent_urls);
    }

    const maxResults = input.max_results ?? processed.length;
    const items: SearchResultItem[] = processed.slice(0, maxResults).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      relevance_score: r.relevance_score,
      ...(r.published_date ? { published_date: r.published_date } : {}),
    }));

    const elapsed = Date.now() - start;
    const data: SearchOutput = {
      results: items,
      query: displayQuery,
      engines_used: enginesUsed,
      total_time_ms: elapsed,
      search_time_ms: elapsed,
    };

    if (allDegraded) {
      data.warning = 'all engines failed or no results';
    }

    return { ok: true, data };
  }
}
