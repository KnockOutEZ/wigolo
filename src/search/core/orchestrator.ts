import type {
  EvidenceScore,
  RawSearchResult,
  ScoreBreakdown,
  SearchEngineOptions,
} from '../../types.js';
import { createLogger } from '../../logger.js';
import { classifyIntentDetailed, type Vertical } from './intent-router.js';
import {
  runEnginesParallel,
  type EngineEntry,
  type EngineOutcome,
} from './engine-base.js';
import { recencyMultiplier, hasTemporalIntent } from './recency-boost.js';
import { applyAuthorityBoost } from '../reranker/authority-boost.js';
import { domainQualityScore } from './domain-quality.js';
import { lexicalAlignment } from './lexical-alignment.js';
import { resolveTimeRange, type TimeRange } from './time-range.js';
import { getConfig } from '../../config.js';

// Hosts matching this regex are demoted when the query is ≤2 tokens — short
// brand-name queries like "next" tend to surface retail collisions
// (next.co.uk fashion, bestbuy.com, etsy.com store fronts) that crowd out
// the intended technical subject. Heuristic; only fires on short queries.
const RETAIL_TLD_RE = /\.(?:co\.uk|shop|store|deals|sale|boutique|fashion)$/i;
const BRAND_COLLISION_PENALTY = 0.3;

function explainEvidence(parts: {
  base: number;
  dq: number;
  la: number;
  recencyMul: number;
  engineConsensus: number;
}): string {
  const tokens: string[] = [];
  tokens.push(`base=${parts.base.toFixed(3)}`);
  tokens.push(`domain=${parts.dq.toFixed(2)}`);
  tokens.push(`lex=${parts.la.toFixed(2)}`);
  if (parts.recencyMul !== 1) tokens.push(`recency=${parts.recencyMul.toFixed(2)}`);
  tokens.push(`engines=${parts.engineConsensus}`);
  return tokens.join(', ');
}

function applyBrandCollisionGuard(query: string, results: RawSearchResult[]): RawSearchResult[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 2) return results;
  if (results.length === 0) return results;

  return results.map((r) => {
    let host = '';
    try {
      host = new URL(r.url).hostname.toLowerCase();
    } catch {
      return r;
    }
    if (RETAIL_TLD_RE.test(host)) {
      return { ...r, relevance_score: r.relevance_score * BRAND_COLLISION_PENALTY };
    }
    return r;
  });
}
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
  /** When true, each returned result carries a `_score_breakdown` field.
   * Wired from SearchInput.include_engine_outcomes at the provider layer. */
  includeScoreBreakdown?: boolean;
  /** ISO 3166-1 alpha-2 country code. Threaded to engines that support a
   * geographic boost; advisory, not a strict filter. */
  country?: string;
  /** Caller-supplied freshness window. Overrides any date hint inferred
   * from the query text. Resolved to a `fromDate` relative to now and
   * passed to engines; results older than the window are post-filtered
   * out (unless they have no published_date — kept conservatively). */
  timeRange?: TimeRange;
  /** When true, the query is wrapped in double quotes before dispatch
   * (engines that honour `"..."` treat it as a phrase match) and any
   * result whose title+snippet does not contain the unquoted query as a
   * case-insensitive substring is dropped post-rerank. */
  exactMatch?: boolean;
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

  // exact_match: quote the query for engines that honour `"..."`. Strip any
  // existing surrounding quotes so we don't double-wrap.
  const engineQuery = input.exactMatch
    ? `"${query.replace(/^"|"$/g, '')}"`
    : query;
  const exactPhrase = input.exactMatch
    ? query.replace(/^"|"$/g, '').toLowerCase()
    : '';

  const timeRangeHint = resolveTimeRange(input.timeRange);
  const callerHasDateBound = !!(input.fromDate || input.toDate || timeRangeHint);
  const classification = classifyIntentDetailed(query, {
    hint: input.category,
    hasDateBound: callerHasDateBound,
  });
  const vertical = classification.vertical;
  // time_range > from/to_date > inferred-from-query hint.
  const dateHint = timeRangeHint ?? classification.dateHint;

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
    country: input.country,
    timeRange: input.timeRange,
    category: vertical === 'general' ? undefined : vertical,
  };

  log.info('orchestrator dispatching engines', {
    vertical,
    engineCount: entries.length,
    hasDateBound,
  });

  const outcomes = await runEnginesParallel(entries, engineQuery, options);

  const wantsRecency =
    vertical === 'news' || hasDateBound || hasTemporalIntent(query);

  // Per-engine dedup, then RRF with per-entry weights and optional recency boost.
  const fused = new Map<string, number>();
  const urlToResult = new Map<string, RawSearchResult>();
  // Track per-URL contributor counts so we can flag results that came only
  // from secondary engines (see sub-ticket 2.2).
  const urlPrimaryCount = new Map<string, number>();
  const urlSecondaryCount = new Map<string, number>();

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (!outcome.ok || outcome.results.length === 0) continue;
    const dedupedResults = dedupWithinEngine(outcome.results);
    // Replace results in outcome to keep telemetry consistent with what we fused.
    outcome.results = dedupedResults;

    const weight = entries[i].weight ?? 1;
    const isSecondary = entries[i].secondary === true;
    for (let j = 0; j < dedupedResults.length; j++) {
      const r = dedupedResults[j];
      const rank = j + 1;
      const base = weight / (RRF_K + rank);
      const recMul = wantsRecency ? recencyMultiplier(r.published_date) : 1.0;
      fused.set(r.url, (fused.get(r.url) ?? 0) + base * recMul);
      if (!urlToResult.has(r.url)) {
        urlToResult.set(r.url, r);
      }
      if (isSecondary) {
        urlSecondaryCount.set(r.url, (urlSecondaryCount.get(r.url) ?? 0) + 1);
      } else {
        urlPrimaryCount.set(r.url, (urlPrimaryCount.get(r.url) ?? 0) + 1);
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
  merged = applyBrandCollisionGuard(query, merged);

  // Brand-collision rank (sub-ticket 2.1): damp brand-domain matches and
  // results whose surface text has near-zero overlap with the query before
  // the threshold cut. Without this, `next.co.uk` for a `next.js` query
  // pre-normalises higher than `nextjs.org` and post-normalises to 1.0.
  const breakdowns = input.includeScoreBreakdown
    ? new Map<string, ScoreBreakdown>()
    : undefined;
  // Sub-ticket 3.8: explainable per-result score breakdown, always emitted.
  const evidenceScores = new Map<string, EvidenceScore>();
  merged = merged.map((r) => {
    const base = r.relevance_score;
    const dq = domainQualityScore(r.url, vertical, query);
    const la = lexicalAlignment(query, r.title, r.snippet);
    const primaryCount = urlPrimaryCount.get(r.url) ?? 0;
    const secondaryCount = urlSecondaryCount.get(r.url) ?? 0;
    const isSecondaryOnly = primaryCount === 0 && secondaryCount > 0;
    const secondaryPenalty = isSecondaryOnly && la < 0.5 ? 0.3 : 1.0;
    const recencyMul = wantsRecency ? recencyMultiplier(r.published_date) : 1.0;
    const final = base * dq * (0.5 + 0.5 * la) * secondaryPenalty;
    if (breakdowns) {
      breakdowns.set(r.url, {
        base,
        domain_quality: dq,
        lexical_alignment: la,
        final,
      });
    }
    evidenceScores.set(r.url, {
      final,
      components: {
        base_rrf: base,
        context_cosine: 0,
        domain_quality: dq,
        lexical_alignment: la,
        recency_boost: recencyMul,
        engine_consensus: primaryCount + secondaryCount,
      },
      explanation: explainEvidence({
        base,
        dq,
        la,
        recencyMul,
        engineConsensus: primaryCount + secondaryCount,
      }),
    });
    return { ...r, relevance_score: final };
  });

  merged.sort((a, b) => b.relevance_score - a.relevance_score);

  merged = applyDomainFilters(merged, input.includeDomains, input.excludeDomains);

  if (effectiveFromDate) {
    merged = merged.filter((r) => {
      if (!r.published_date) return true;
      return r.published_date >= effectiveFromDate;
    });
  }
  if (effectiveToDate) {
    merged = merged.filter((r) => {
      if (!r.published_date) return true;
      return r.published_date <= effectiveToDate;
    });
  }
  if (exactPhrase) {
    merged = merged.filter((r) => {
      const hay = `${r.title} ${r.snippet}`.toLowerCase();
      return hay.includes(exactPhrase);
    });
  }

  const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  let results = merged.slice(0, maxResults);

  if (results.length > 0) {
    const maxFinal = Math.max(...results.map((r) => r.relevance_score));
    if (maxFinal > 0) {
      results = results.map((r) => ({ ...r, relevance_score: r.relevance_score / maxFinal }));
    }
  }

  const threshold = getConfig().relevanceThreshold;
  if (threshold > 0) {
    results = results.filter((r) => r.relevance_score >= threshold);
  }

  if (breakdowns) {
    results = results.map((r) => {
      const bd = breakdowns.get(r.url);
      return bd ? { ...r, _score_breakdown: bd } : r;
    });
  }

  // Attach evidence_score using the final renormalised relevance_score so
  // the explainability matches what callers see in relevance_score.
  results = results.map((r) => {
    const ev = evidenceScores.get(r.url);
    if (!ev) return r;
    return { ...r, evidence_score: { ...ev, final: r.relevance_score } };
  });

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
