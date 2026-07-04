import type {
  EnginePoolHealth,
  EvidenceScore,
  RawSearchResult,
  ScoreBreakdown,
  SearchEngineOptions,
} from '../../types.js';
import { createLogger } from '../../logger.js';
import {
  classifyIntentDetailed,
  extractErrorTokens,
  type Vertical,
} from './intent-router.js';
import {
  runEnginesParallel,
  type EngineEntry,
  type EngineOutcome,
  type RunEnginesOptions,
} from './engine-base.js';
import { recencyMultiplier, hasTemporalIntent } from './recency-boost.js';
import { applyAuthorityBoost } from '../reranker/authority-boost.js';
import { domainQualityScore } from './domain-quality.js';
import { lexicalAlignment } from './lexical-alignment.js';
import { detectRareTerms, rareTermFactor, isRareTermMiss } from './rare-terms.js';
import { resolveTimeRange, isDatedOutOfWindow, type TimeRange } from './time-range.js';
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
import { resolveEngineWeight } from './engine-quality.js';
import { canonicalizeUrl } from './canonical-url.js';
import { getGeneralEngines, _resetGeneralEnginesForTest } from './verticals/general.js';
import { getNewsEngines, _resetNewsEnginesForTest } from './verticals/news.js';
import { getCodeEngines, _resetCodeEnginesForTest } from './verticals/code.js';
import { getDocsEngines, _resetDocsEnginesForTest } from './verticals/docs.js';
import { getPapersEngines, _resetPapersEnginesForTest } from './verticals/papers.js';
import { getImageEngines, _resetImageEnginesForTest } from './verticals/images.js';

const log = createLogger('search');

const RRF_K = 60;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
// Overall soft deadline for a dispatch wave. The per-engine abort budget
// (options.timeoutMs, 10s) still bounds each engine, but a single straggler
// hanging toward that 10s dragged the whole Promise.all response. This soft
// deadline lets fast + slow-but-real engines return (observed healthy engines
// settle in <1s) while capping the tail: once it elapses, engines still in
// flight are recorded as timed-out and no longer awaited (their request keeps
// running and may still populate cache). Kept well under DEFAULT_TIMEOUT_MS.
const ENGINE_POOL_SOFT_DEADLINE_MS = 3_500;
// Tighter budget applied ONLY to engines the breaker has marked chronically
// unhealthy this session (repeated trips). Stops the pool from paying a
// perma-failing engine's straggler cost on every call while a healthy or
// transiently-slow engine keeps the full pool deadline. Generic + data-driven.
const ENGINE_POOL_CHRONIC_SOFT_DEADLINE_MS = 1_200;
// A non-general vertical returning fewer than this after fusion is starved:
// its engine pool is too thin for the query. We backfill from the general
// pool rather than shipping a near-empty set.
const STARVATION_FLOOR = 3;
// Undated results on a recency-bound query are kept but demoted so dated,
// in-window pages win the top slots without collapsing recall.
const UNDATED_DEMOTION = 0.3;

// Wrap every error/status-code token in the query in double quotes in place so
// engines treat the code as one atom (substring matching on an unquoted code
// lets glossary/definition junk rank). Idempotent: already-quoted tokens are
// left alone.
function quoteErrorTokens(query: string): string {
  const tokens = extractErrorTokens(query);
  if (tokens.length === 0) return query;
  let out = query;
  for (const tok of tokens) {
    // Replace the bare token (not one already inside quotes) with a quoted form.
    const re = new RegExp(`(?<!")\\b${escapeRegExp(tok)}\\b(?!")`, 'g');
    out = out.replace(re, `"${tok}"`);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a `site:` operator group for engines that honour it, e.g.
// ` (site:a.com OR site:b.com)`. Only emitted for a small domain set —
// beyond that the operator string bloats and some engines choke.
const MAX_SITE_SCOPE_DOMAINS = 3;
function siteScopeSuffix(includeDomains?: string[]): string {
  if (!includeDomains?.length || includeDomains.length > MAX_SITE_SCOPE_DOMAINS) {
    return '';
  }
  const clauses = includeDomains
    .map((d) => d.trim().replace(/^\./, ''))
    .filter(Boolean)
    .map((d) => `site:${d}`);
  if (clauses.length === 0) return '';
  return clauses.length === 1 ? ` ${clauses[0]}` : ` (${clauses.join(' OR ')})`;
}

// Hard freshness window: drop DATED results whose parsed published_date is
// provably outside the requested [fromDate, toDate] window. Per-result on the
// isDatedOutOfWindow predicate — undated / unparseable results survive (kept
// conservatively, consistent with the undated-demotion path). Uses parsed
// calendar time, not a string compare, so a dated-but-old result in a non-ISO
// format (e.g. "Jan 15, 2026") can no longer slip a week window. Non-empty
// guarantee: if the window would drop everything, the pre-filter set is kept so
// scarce in-window coverage never collapses to zero results.
function applyFreshnessWindow(
  results: RawSearchResult[],
  fromDate: string | undefined,
  toDate: string | undefined,
): RawSearchResult[] {
  if (!fromDate && !toDate) return results;
  const kept = results.filter((r) => !isDatedOutOfWindow(r.published_date, fromDate, toDate));
  return kept.length > 0 ? kept : results;
}

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
  /** Set when the engine pool degraded during this dispatch — e.g. a thin
   * vertical starved and was backfilled from the general pool. Carries the
   * merged engine count + the reasons that fired. Consumed by core-provider,
   * which surfaces it as SearchOutput.engine_pool. */
  pool_degraded?: EnginePoolHealth;
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
    case 'images':
      return getImageEngines();
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

// include_domains is a HARD whitelist: any result whose hostname does not
// match an entry is dropped (host-suffix match — `docs.foo.com` matches
// `foo.com`). exclude_domains is the symmetric hard drop. Earlier versions
// applied a soft floor that demoted off-domain results when matches were
// below 3; that leaked off-domain URLs into responses. Hard enforcement
// matches what wigolo advertises.
function applyDomainFilters(
  results: RawSearchResult[],
  includeDomains?: string[],
  excludeDomains?: string[],
): RawSearchResult[] {
  let filtered = results;

  if (excludeDomains?.length) {
    filtered = filtered.filter((r) => {
      const host = hostnameOf(r.url);
      if (!host) return false;
      return !excludeDomains.some((d) => matchesDomain(host, d));
    });
  }

  if (!includeDomains?.length) return filtered;

  return filtered.filter((r) => {
    const host = hostnameOf(r.url);
    if (!host) return false;
    return includeDomains.some((d) => matchesDomain(host, d));
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

  // exact_match: quote the whole query for engines that honour `"..."`. Strip
  // any existing surrounding quotes so we don't double-wrap. Otherwise, quote
  // any code-shaped tokens in place so a code is matched as one atom and
  // glossary/definition junk can't rank on a bare substring match. This uses
  // the BROAD token set (quoting an acronym is benign); docs-suppression and
  // dictionary demotion gate on the STRICT queryHasErrorToken instead.
  const hasQuotableToken = extractErrorTokens(query).length > 0;
  const engineQuery = input.exactMatch
    ? `"${query.replace(/^"|"$/g, '')}"`
    : hasQuotableToken
      ? quoteErrorTokens(query)
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

  // A date bound no longer narrows the
  // engine set. The previous behaviour dropped every date-naive engine the
  // moment one date-aware engine was present, which collapsed a date-bounded
  // news search to HN-Algolia alone (2 results). Server-side date filtering
  // is best-effort: engines that support it get fromDate/toDate in options;
  // engines that don't still run and contribute recall. Their results are
  // freshness-filtered client-side below (effectiveFromDate/effectiveToDate
  // post-filter), which drops older-than-window results while keeping
  // within-window AND undated ones — so recall isn't sacrificed for results
  // that merely lack a parseable published_date.
  const entries = allEntries;

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

  // Soft deadline shared by every dispatch wave: bound the overall wait so one
  // slow/hung engine can't drag the response to its 10s abort budget; a
  // chronically-tripped engine gets the tighter budget. Same config across the
  // primary + backfill + starvation waves so latency is bounded uniformly.
  const runOptions: RunEnginesOptions = {
    softDeadlineMs: ENGINE_POOL_SOFT_DEADLINE_MS,
    chronicSoftDeadlineMs: ENGINE_POOL_CHRONIC_SOFT_DEADLINE_MS,
  };

  log.info('orchestrator dispatching engines', {
    vertical,
    engineCount: entries.length,
    hasDateBound,
  });

  // Initial dispatch: engineQuery carries the error-token quoting (if any). For
  // a small include_domains set we additionally inject a `site:` operator group
  // so engines that honour it narrow at the source; applyDomainFilters below is
  // still the hard post-filter safety net.
  const primaryDispatchQuery = engineQuery + siteScopeSuffix(input.includeDomains);
  const outcomes = await runEnginesParallel(entries, primaryDispatchQuery, options, runOptions);

  const wantsRecency =
    vertical === 'news' || hasDateBound || hasTemporalIntent(query);
  // Undated results are demoted (not dropped) when the caller set an explicit
  // recency window on a recency-sensitive query: news vertical, or a caller
  // date bound / temporal-intent query. Keeps recall while letting dated
  // in-window pages win the top slots.
  const demoteUndated = hasDateBound && wantsRecency;

  const canonKey = (url: string): string => {
    try {
      return canonicalizeUrl(url);
    } catch {
      return url;
    }
  };

  const rare = detectRareTerms(query);
  const hasRareTerms = rare.compoundTokens.length > 0 || rare.conceptPhrase !== null;
  const breakdowns = input.includeScoreBreakdown
    ? new Map<string, ScoreBreakdown>()
    : undefined;
  // Sub-ticket 3.8: explainable per-result score breakdown, always emitted.
  const evidenceScores = new Map<string, EvidenceScore>();
  // exact_match phrase awareness: canonical keys whose contributing engine's
  // title+snippet contained the exact phrase. Hoisted so the post-fusion
  // exact-phrase filter can read it; repopulated on each scoreOutcomes call.
  const urlExactMatchHit = new Set<string>();

  // Fuse + score a set of engine outcomes into a sorted result list. Rebuilt
  // from scratch each call so a backfill / starvation wave that appends more
  // outcomes re-runs RRF + the full score map over the combined set (per-result
  // merge, not a naive concat). `entryList` must be positionally aligned with
  // `outcomeList` so per-engine weight/secondary metadata lines up.
  function scoreOutcomes(
    outcomeList: EngineOutcome[],
    entryList: EngineEntry[],
  ): RawSearchResult[] {
    const fused = new Map<string, number>();
    const urlToResult = new Map<string, RawSearchResult>();
    const urlPrimaryCount = new Map<string, number>();
    const urlSecondaryCount = new Map<string, number>();
    urlExactMatchHit.clear();
    // A shared engine (e.g. DuckDuckGo, Brave) can dispatch across more than
    // one wave — the vertical pool plus the domain-backfill / starvation
    // re-dispatch. Count each (engine, canonical-url) pair ONCE (first, best-
    // rank occurrence wins) so a URL a shared engine returns in two waves
    // doesn't get its RRF contribution + consensus double-summed.
    const countedByEngine = new Set<string>();

    for (let i = 0; i < outcomeList.length; i++) {
      const outcome = outcomeList[i];
      if (!outcome.ok || outcome.results.length === 0) continue;
      const dedupedResults = dedupWithinEngine(outcome.results);
      outcome.results = dedupedResults;
      const engineName = entryList[i].engine.name;
      const weight = resolveEngineWeight(
        engineName,
        entryList[i].weight,
        entryList[i].quality,
      );
      const isSecondary = entryList[i].secondary === true;
      for (let j = 0; j < dedupedResults.length; j++) {
        const r = dedupedResults[j];
        const rank = j + 1;
        const base = weight / (RRF_K + rank);
        const recMul = wantsRecency ? recencyMultiplier(r.published_date) : 1.0;
        const key = canonKey(r.url);
        const engineUrlKey = `${engineName} ${key}`;
        if (countedByEngine.has(engineUrlKey)) {
          // Same engine already contributed this URL in an earlier wave —
          // still record first-seen result/exact-phrase, but don't re-sum.
          if (!urlToResult.has(key)) urlToResult.set(key, r);
          continue;
        }
        countedByEngine.add(engineUrlKey);
        fused.set(key, (fused.get(key) ?? 0) + base * recMul);
        if (!urlToResult.has(key)) urlToResult.set(key, r);
        if (isSecondary) {
          urlSecondaryCount.set(key, (urlSecondaryCount.get(key) ?? 0) + 1);
        } else {
          urlPrimaryCount.set(key, (urlPrimaryCount.get(key) ?? 0) + 1);
        }
        if (exactPhrase) {
          const hay = `${r.title} ${r.snippet}`.toLowerCase();
          if (hay.includes(exactPhrase)) urlExactMatchHit.add(key);
        }
      }
    }

    // Write the raw RRF score (small, ~0.016 range) into relevance_score so
    // downstream additive boosters (authority) dominate engine arrival order.
    let scored: RawSearchResult[] = [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, score]) => {
        const base = urlToResult.get(key);
        return base ? { ...base, relevance_score: score } : undefined;
      })
      .filter((r): r is RawSearchResult => r !== undefined);

    // Cap generic authority per-result for rare-term MISSES only.
    const capUrls = hasRareTerms
      ? new Set(scored.filter((r) => isRareTermMiss(r, rare)).map((r) => r.url))
      : undefined;
    scored = applyAuthorityBoost(query, scored, { capUrls });
    scored = applyBrandCollisionGuard(query, scored);

    if (breakdowns) breakdowns.clear();
    evidenceScores.clear();
    scored = scored.map((r) => {
      const key = canonKey(r.url);
      const base = r.relevance_score;
      const dq = domainQualityScore(r.url, vertical, query);
      const la = lexicalAlignment(query, r.title, r.snippet);
      const primaryCount = urlPrimaryCount.get(key) ?? 0;
      const secondaryCount = urlSecondaryCount.get(key) ?? 0;
      const isSecondaryOnly = primaryCount === 0 && secondaryCount > 0;
      const secondaryPenalty = isSecondaryOnly && la < 0.5 ? 0.3 : 1.0;
      const recencyMul = wantsRecency ? recencyMultiplier(r.published_date) : 1.0;
      // Demote undated results on a recency-bound query so dated in-window
      // pages outrank them, without dropping them (recall preserved).
      const undatedMul = demoteUndated && !r.published_date ? UNDATED_DEMOTION : 1.0;
      const rtf = rareTermFactor({ title: r.title, url: r.url, snippet: r.snippet }, rare);
      const final = base * dq * (0.5 + 0.5 * la) * secondaryPenalty * rtf * undatedMul;
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
          rare_terms: rtf,
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

    scored.sort((a, b) => b.relevance_score - a.relevance_score);
    return scored;
  }

  // Accumulate outcomes + their aligned entries across dispatch waves so the
  // score map fuses every wave per-result rather than concatenating.
  const allOutcomes: EngineOutcome[] = [...outcomes];
  const wavedEntries: EngineEntry[] = [...entries];

  // Dispatch-level domain scoping starves the on-domain set (site: narrows
  // recall). When the primary wave used a site-scoped query and the post-filter
  // survivors fall short of maxResults, run one broad backfill wave (no site:
  // scoping) and re-apply the hard filter — refilling with on-domain survivors
  // the narrow wave missed.
  const requestedMax = input.maxResults ?? DEFAULT_MAX_RESULTS;
  const siteScoped = siteScopeSuffix(input.includeDomains) !== '';
  if (siteScoped) {
    const preBackfill = applyDomainFilters(
      scoreOutcomes(allOutcomes, wavedEntries),
      input.includeDomains,
      input.excludeDomains,
    );
    if (preBackfill.length < requestedMax) {
      const backfillOutcomes = await runEnginesParallel(entries, engineQuery, options, runOptions);
      allOutcomes.push(...backfillOutcomes);
      wavedEntries.push(...entries);
    }
  }

  let merged = scoreOutcomes(allOutcomes, wavedEntries);

  merged = applyDomainFilters(merged, input.includeDomains, input.excludeDomains);

  merged = applyFreshnessWindow(merged, effectiveFromDate, effectiveToDate);
  if (exactPhrase) {
    // union of (urlExactMatchHit observed during ingest) ∪ (post-merge
    // title+snippet match on the urlToResult variant). The post-merge check
    // catches the case where engines were rewritten/reranked between ingest
    // and this point; the ingest set rescues URLs whose preferred variant
    // (kept by urlToResult, first-seen wins) didn't have the phrase but
    // another engine's variant did.
    merged = merged.filter((r) => {
      const key = canonKey(r.url);
      if (urlExactMatchHit.has(key)) return true;
      const hay = `${r.title} ${r.snippet}`.toLowerCase();
      return hay.includes(exactPhrase);
    });
  }

  // Per-result starvation re-dispatch: a non-general/non-images vertical that
  // fused fewer than STARVATION_FLOOR (and below the requested max) has a pool
  // too thin for the query. Pull the general pool with the SAME query+options
  // and RRF-merge its results in per-result (re-run the score map over the
  // combined outcomes). Gated on post-fusion COUNT, distinct from the query-
  // wide degraded fallback below (which only fires at zero results).
  let poolDegraded: EnginePoolHealth | undefined;
  const starvationFloor = Math.min(requestedMax, STARVATION_FLOOR);
  // Partial-starvation only: the vertical returned SOME results but fewer than
  // the floor. A zero-result vertical is left to the query-wide degraded
  // fallback below (which re-runs as general AND reports vertical='general'),
  // so the two paths don't both fire on the same empty vertical.
  if (
    merged.length > 0 &&
    merged.length < starvationFloor &&
    vertical !== 'general' &&
    vertical !== 'images' &&
    !opts._isFallback
  ) {
    const generalEntries = getGeneralEngines();
    if (generalEntries.length > 0) {
      log.info('vertical starved below floor, backfilling from general', {
        from: vertical,
        count: merged.length,
        floor: starvationFloor,
      });
      const generalOutcomes = await runEnginesParallel(
        generalEntries,
        engineQuery,
        options,
        runOptions,
      );
      allOutcomes.push(...generalOutcomes);
      wavedEntries.push(...generalEntries);
      merged = scoreOutcomes(allOutcomes, wavedEntries);
      merged = applyDomainFilters(merged, input.includeDomains, input.excludeDomains);
      merged = applyFreshnessWindow(merged, effectiveFromDate, effectiveToDate);
      if (exactPhrase) {
        merged = merged.filter((r) => {
          const key = canonKey(r.url);
          if (urlExactMatchHit.has(key)) return true;
          const hay = `${r.title} ${r.snippet}`.toLowerCase();
          return hay.includes(exactPhrase);
        });
      }
      const healthy = allOutcomes.filter((o) => o.ok && o.results.length > 0).length;
      poolDegraded = {
        healthy,
        total: allOutcomes.length,
        degraded: true,
        reasons: ['starvation_redispatch'],
      };
    }
  }

  const maxResults = requestedMax;
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

  const enginesUsed = allOutcomes
    .filter((o) => o.ok && o.results.length > 0)
    .map((o) => o.engine);

  const degraded = allOutcomes.every((o) => !o.ok) || results.length === 0;

  if (degraded) {
    log.warn('orchestrator returning degraded result', {
      vertical,
      attempted: allOutcomes.length,
      ok: allOutcomes.filter((o) => o.ok).length,
      resultCount: results.length,
    });
  }

  // Fallback: any non-general vertical that came back degraded gets one
  // automatic retry as general. Code in particular is prone to empty results
  // (GH code search returns nothing + SO times out → empty), but this is
  // generic safety net for every vertical except general (which has nowhere
  // to fall back to). Images explicitly opt out: callers who asked for image
  // search would be confused to receive HTML-page results, so a degraded
  // image vertical surfaces empty + engine_warnings rather than silently
  // morphing into a general search.
  if (degraded && vertical !== 'general' && vertical !== 'images' && !opts._isFallback) {
    log.info('vertical degraded, falling back to general', { from: vertical });
    return runV1Search({ ...input, category: 'general' }, { _isFallback: true });
  }

  return {
    vertical,
    results,
    enginesUsed,
    outcomes: allOutcomes,
    degraded,
    ...(poolDegraded ? { pool_degraded: poolDegraded } : {}),
  };
}

export function _resetOrchestratorVerticalsForTest(): void {
  _resetGeneralEnginesForTest();
  _resetNewsEnginesForTest();
  _resetCodeEnginesForTest();
  _resetDocsEnginesForTest();
  _resetPapersEnginesForTest();
  _resetImageEnginesForTest();
}
