import type { RawSearchResult, SearchEngineOptions } from '../../types.js';
import { createLogger } from '../../logger.js';
import { classifyIntent, type Vertical } from './intent-router.js';
import {
  runEnginesParallel,
  type EngineEntry,
  type EngineOutcome,
} from './engine-base.js';
import { buildRankMap } from '../rrf.js';
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

function applyDomainFilters(
  results: RawSearchResult[],
  includeDomains?: string[],
  excludeDomains?: string[],
): RawSearchResult[] {
  if (!includeDomains?.length && !excludeDomains?.length) return results;
  return results.filter((r) => {
    const host = hostnameOf(r.url);
    if (includeDomains?.length && !includeDomains.some((d) => matchesDomain(host, d))) {
      return false;
    }
    if (excludeDomains?.length && excludeDomains.some((d) => matchesDomain(host, d))) {
      return false;
    }
    return true;
  });
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

export async function runV1Search(
  input: OrchestratorInput,
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

  const hasDateBound = !!(input.fromDate || input.toDate);
  const vertical = classifyIntent(query, { hint: input.category, hasDateBound });

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
    fromDate: input.fromDate,
    toDate: input.toDate,
    category: vertical === 'general' ? undefined : vertical,
  };

  log.info('orchestrator dispatching engines', {
    vertical,
    engineCount: entries.length,
    hasDateBound,
  });

  const outcomes = await runEnginesParallel(entries, query, options);

  // Per-engine dedup, then RRF with per-entry weights.
  const fused = new Map<string, number>();
  const urlToResult = new Map<string, RawSearchResult>();

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (!outcome.ok || outcome.results.length === 0) continue;
    const dedupedResults = dedupWithinEngine(outcome.results);
    // Replace results in outcome to keep telemetry consistent with what we fused.
    outcome.results = dedupedResults;

    const weight = entries[i].weight ?? 1;
    const rankMap = buildRankMap(dedupedResults.map((r) => r.url));
    for (const [url, rank] of rankMap) {
      fused.set(url, (fused.get(url) ?? 0) + weight / (RRF_K + rank));
    }
    for (const r of dedupedResults) {
      if (!urlToResult.has(r.url)) {
        urlToResult.set(r.url, r);
      }
    }
  }

  const sortedUrls = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url);

  let merged: RawSearchResult[] = sortedUrls
    .map((url) => urlToResult.get(url))
    .filter((r): r is RawSearchResult => r !== undefined);

  merged = applyDomainFilters(merged, input.includeDomains, input.excludeDomains);

  const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  const results = merged.slice(0, maxResults);

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
