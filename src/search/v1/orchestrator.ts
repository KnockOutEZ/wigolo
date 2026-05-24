import type { RawSearchResult, SearchEngineOptions } from '../../types.js';
import { createLogger } from '../../logger.js';
import { classifyIntentDetailed, type Vertical } from './intent-router.js';
import {
  runEnginesParallel,
  type EngineEntry,
  type EngineOutcome,
} from './engine-base.js';
import { recencyMultiplier, hasTemporalIntent } from './recency-boost.js';
import { applyAuthorityBoost } from '../reranker/authority-boost.js';
import { getGeneralEngines, _resetGeneralEnginesForTest } from './verticals/general.js';
import { getNewsEngines, _resetNewsEnginesForTest } from './verticals/news.js';
import { getCodeEngines, _resetCodeEnginesForTest } from './verticals/code.js';
import { getDocsEngines, _resetDocsEnginesForTest } from './verticals/docs.js';
import { getPapersEngines, _resetPapersEnginesForTest } from './verticals/papers.js';

const log = createLogger('search');

const RRF_K = 60;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface OrchestratorInput {
  query: string;
  category?: Vertical;
  fromDate?: string;
  toDate?: string;
  maxResults?: number;
  timeoutMs?: number;
  language?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface OrchestratorOutput {
  vertical: Vertical;
  results: RawSearchResult[];
  enginesUsed: string[];
  outcomes: EngineOutcome[];
  degraded: boolean;
}

function getEntriesForVertical(vertical: Vertical): EngineEntry[] {
  switch (vertical) {
    case 'general':
      return getGeneralEngines();
    case 'news':
      return getNewsEngines();
    case 'code':
      return getCodeEngines();
    case 'docs':
      return getDocsEngines();
    case 'papers':
      return getPapersEngines();
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matchesDomain(host: string, domain: string): boolean {
  const needle = domain.toLowerCase().replace(/^\./, '');
  if (!host) return false;
  return host === needle || host.endsWith(`.${needle}`);
}

// Surviving include_domains matches below this floor trigger a backfill from
// the filtered-out pool so callers never get a single-result (or empty)
// response when the request has results outside the include set. Tavily-equivalent.
const SOFT_INCLUDE_FLOOR = 3;

function applyDomainFilters(
  results: RawSearchResult[],
  includeDomains?: string[],
  excludeDomains?: string[],
): RawSearchResult[] {
  let filtered = results;

  if (excludeDomains?.length) {
    filtered = filtered.filter((r) => {
      const host = hostnameOf(r.url);
      return !excludeDomains.some((d) => matchesDomain(host, d));
    });
  }

  if (!includeDomains?.length) return filtered;

  const matching: RawSearchResult[] = [];
  const nonMatching: RawSearchResult[] = [];
  for (const r of filtered) {
    const host = hostnameOf(r.url);
    if (includeDomains.some((d) => matchesDomain(host, d))) {
      matching.push(r);
    } else {
      nonMatching.push(r);
    }
  }

  if (matching.length >= SOFT_INCLUDE_FLOOR || nonMatching.length === 0) {
    return matching;
  }

  // Demote non-matches so they always sort below the lowest-scored match.
  const minMatchScore = matching.length > 0
    ? Math.min(...matching.map((r) => r.relevance_score))
    : 1;
  const demoteCap = minMatchScore > 0 ? minMatchScore * 0.5 : 0.001;
  const demoted = nonMatching.map((r) => ({
    ...r,
    relevance_score: Math.min(r.relevance_score, demoteCap),
  }));

  return [...matching, ...demoted];
}

// Defensive per-engine dedup: keep first occurrence by URL.
function dedupWithinEngine(results: RawSearchResult[]): RawSearchResult[] {
  const seen = new Set<string>();
  const out: RawSearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

interface RunV1SearchOptions {
  _isFallback?: boolean;
}

export async function runV1Search(
  input: OrchestratorInput,
  opts: RunV1SearchOptions = {},
): Promise<OrchestratorOutput> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (query.length === 0) {
    log.warn('orchestrator received empty query');
    return {
      vertical: 'general',
      results: [],
      enginesUsed: [],
      outcomes: [],
      degraded: true,
    };
  }

  const callerHasDateBound = !!(input.fromDate || input.toDate);
  const classification = classifyIntentDetailed(query, {
    hint: input.category,
    hasDateBound: callerHasDateBound,
  });
  const vertical = classification.vertical;
  const dateHint = classification.dateHint;

  const effectiveFromDate = input.fromDate ?? dateHint?.fromDate;
  const effectiveToDate = input.toDate ?? dateHint?.toDate;
  const hasDateBound = !!(effectiveFromDate || effectiveToDate);

  const allEntries = getEntriesForVertical(vertical);

  // Date-support filtering. If no engines remain, silently fall back to the
  // full entry list — the engines may still filter client-side, and a later
  // rerank step can apply temporal weighting. Better than returning empty.
  let entries = allEntries;
  if (hasDateBound) {
    const dateAware = allEntries.filter((e) => e.supportsDateFilter === true);
    entries = dateAware.length > 0 ? dateAware : allEntries;
  }

  const options: SearchEngineOptions = {
    maxResults: input.maxResults ?? DEFAULT_MAX_RESULTS,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    language: input.language,
    includeDomains: input.includeDomains,
    excludeDomains: input.excludeDomains,
    fromDate: effectiveFromDate,
    toDate: effectiveToDate,
    category: vertical === 'general' ? undefined : vertical,
  };

  log.info('orchestrator dispatching engines', {
    vertical,
    engineCount: entries.length,
    hasDateBound,
  });

  const outcomes = await runEnginesParallel(entries, query, options);

  const wantsRecency =
    vertical === 'news' || hasDateBound || hasTemporalIntent(query);

  // Per-engine dedup, then RRF with per-entry weights and optional recency boost.
  const fused = new Map<string, number>();
  const urlToResult = new Map<string, RawSearchResult>();

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (!outcome.ok || outcome.results.length === 0) continue;
    const dedupedResults = dedupWithinEngine(outcome.results);
    // Replace results in outcome to keep telemetry consistent with what we fused.
    outcome.results = dedupedResults;

    const weight = entries[i].weight ?? 1;
    for (let j = 0; j < dedupedResults.length; j++) {
      const r = dedupedResults[j];
      const rank = j + 1;
      const base = weight / (RRF_K + rank);
      const recMul = wantsRecency ? recencyMultiplier(r.published_date) : 1.0;
      fused.set(r.url, (fused.get(r.url) ?? 0) + base * recMul);
      if (!urlToResult.has(r.url)) {
        urlToResult.set(r.url, r);
      }
    }
  }

  // Write the raw RRF score (small, ~0.016 range) into relevance_score so
  // downstream additive boosters (authority) dominate engine arrival order.
  // Final score is renormalized to [0,1] after boosting + sort.
  let merged: RawSearchResult[] = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url, score]) => {
      const base = urlToResult.get(url);
      return base ? { ...base, relevance_score: score } : undefined;
    })
    .filter((r): r is RawSearchResult => r !== undefined);

  merged = applyAuthorityBoost(query, merged);
  merged.sort((a, b) => b.relevance_score - a.relevance_score);

  merged = applyDomainFilters(merged, input.includeDomains, input.excludeDomains);

  const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  let results = merged.slice(0, maxResults);

  if (results.length > 0) {
    const maxFinal = Math.max(...results.map((r) => r.relevance_score));
    if (maxFinal > 0) {
      results = results.map((r) => ({ ...r, relevance_score: r.relevance_score / maxFinal }));
    }
  }

  const enginesUsed = outcomes
    .filter((o) => o.ok && o.results.length > 0)
    .map((o) => o.engine);

  const degraded = outcomes.every((o) => !o.ok) || results.length === 0;

  if (degraded) {
    log.warn('orchestrator returning degraded result', {
      vertical,
      attempted: outcomes.length,
      ok: outcomes.filter((o) => o.ok).length,
      resultCount: results.length,
    });
  }

  // Fallback: any non-general vertical that came back degraded gets one
  // automatic retry as general. Code in particular is prone to empty results
  // (GH code search returns nothing + SO times out → empty), but this is
  // generic safety net for every vertical except general (which has nowhere
  // to fall back to).
  if (degraded && vertical !== 'general' && !opts._isFallback) {
    log.info('vertical degraded, falling back to general', { from: vertical });
    return runV1Search({ ...input, category: 'general' }, { _isFallback: true });
  }

  return {
    vertical,
    results,
    enginesUsed,
    outcomes,
    degraded,
  };
}

export function _resetOrchestratorVerticalsForTest(): void {
  _resetGeneralEnginesForTest();
  _resetNewsEnginesForTest();
  _resetCodeEnginesForTest();
  _resetDocsEnginesForTest();
  _resetPapersEnginesForTest();
}
