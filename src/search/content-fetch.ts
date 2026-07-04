import type { SearchResultItem } from '../types.js';
import { type SmartRouter, isAntiBotTlsFirstUrl } from '../fetch/router.js';
import { getConfig } from '../config.js';
import { getExtractProvider } from '../providers/extract-provider.js';
import { cacheContent } from '../cache/store.js';
import { getEmbeddingService } from '../embedding/embed.js';
import { truncateSmartly } from './truncate.js';
import { createLogger } from '../logger.js';
import { anySignal, timeoutSignal, abortRejection } from '../util/abort.js';

const log = createLogger('search');

export interface FetchContentContext {
  contentMaxChars: number;
  maxContentChars?: number;
  maxTotalChars: number;
  fetchTimeoutMs: number;
  totalDeadline: number;
  forceRefresh: boolean;
  maxFetches?: number;
  /** Fetch-stage wall-clock budget in ms. When absent, behavior is equivalent
   *  to today's legacy path: no stage timer, per-URL timeoutSignal is the
   *  only cancellation mechanism. */
  stageBudgetMs?: number;
  /** Per-URL budget for anti-bot/TLS-first domains
   *  (stackoverflow.com et al.). These are routed through the TLS-impersonation
   *  tier first; a working TLS attempt takes ~1-5s and is starved by the small
   *  `fetchTimeoutMs`. When absent, a default larger budget is derived from
   *  `fetchTimeoutMs`/`stageBudgetMs` so existing call sites benefit. Always
   *  clamped to the stage budget so the overall stage stays bounded. */
  antiBotFetchTimeoutMs?: number;
  /** Number of candidates the caller intends to hydrate (typically the fetched
   *  slice size). Used with {@link narrowSetBudgetMs} to scale the per-URL
   *  budget up for a NARROW set — a structural signal, never a domain
   *  allowlist. When absent, no narrow-set scaling applies. */
  candidateCount?: number;
  /** Total per-URL budget pool (ms) shared across the candidate set. With a
   *  narrow set (few candidates), each URL's budget scales toward
   *  `narrowSetBudgetMs / candidateCount`, floored at the small base
   *  `fetchTimeoutMs` and clamped to `stageBudgetMs`. Absent ⇒ legacy path
   *  (no narrow-set bump). */
  narrowSetBudgetMs?: number;
  /** When true, a per-URL/stage/total TIMEOUT falls back to the result's own
   *  snippet as `markdown_content` (flagged `content_from_snippet`) so callers
   *  get evidence text instead of empty content. The failure is still recorded
   *  in `fetch_failed`. Absent/false ⇒ legacy path (empty content on timeout). */
  snippetFallback?: boolean;
  /** Force the browser-render path (renderJs:'always') for a NARROW candidate
   *  set. JS-heavy documentation SPAs served over the HTTP tier hand back an
   *  empty JS shell — extraction "succeeds" with near-empty content, so neither
   *  the timeout path nor the snippet fallback fires and callers get a
   *  content-poor result. When set AND {@link candidateCount} ≤ `maxCandidates`,
   *  the enrichment fetch renders the SPA so real content is recovered. Keys on
   *  `candidateCount` — a STRUCTURAL signal — never a domain allowlist, so cost
   *  stays bounded to a few URLs. Absent ⇒ legacy auto path for every URL
   *  (broad searches never pay the browser cold-start). */
  renderNarrowSet?: { maxCandidates: number };
}

interface SingleFetch {
  content?: string;
  error?: string;
}

/**
 * Narrow-set scaling: when there are FEW candidates to hydrate, each deserves
 * proportionally more time (the stage budget would otherwise sit mostly unspent
 * while a single slow page times out at the small default). Keys on
 * `candidateCount` — a STRUCTURAL signal — never a domain allowlist. Returns the
 * small base budget when scaling is not configured or when the scaled slice is
 * below the base (a WIDE set), preserving today's behavior.
 */
function narrowSetBudgetFor(ctx: FetchContentContext): number {
  if (ctx.narrowSetBudgetMs === undefined || ctx.candidateCount === undefined) {
    return ctx.fetchTimeoutMs;
  }
  const count = Math.max(1, ctx.candidateCount);
  const scaled = Math.floor(ctx.narrowSetBudgetMs / count);
  // Never below the small base — a wide set keeps today's budget.
  return Math.max(ctx.fetchTimeoutMs, scaled);
}

/**
 * Resolve the per-URL fetch budget for a single target.
 * Anti-bot/TLS-first domains (routed through the TLS-impersonation tier first
 * by the router) get the larger {@link FetchContentContext.antiBotFetchTimeoutMs}
 * budget so a working ~1-5s TLS attempt is not starved by the small
 * `fetchTimeoutMs`. A NARROW candidate set (few results) lifts every URL's
 * budget toward `narrowSetBudgetMs / candidateCount`. Everyone else keeps the
 * small budget — no blanket bump.
 *
 * The budget is clamped to the stage budget (when set) so the overall stage
 * stays bounded — the per-URL budget never exceeds the stage ceiling, so the
 * stage timer (not an unbounded per-URL timer) is what caps wall-clock.
 */
function perUrlBudgetFor(url: string, ctx: FetchContentContext): number {
  const narrow = narrowSetBudgetFor(ctx);
  let budget: number;
  if (!isAntiBotTlsFirstUrl(url, getConfig().tlsDomains)) {
    // Non-anti-bot domains keep the small base UNLESS a narrow candidate set
    // grants them more time.
    budget = narrow;
  } else {
    // Default the anti-bot budget to the stage budget when not supplied, so the
    // TLS attempt gets the full hydration window rather than the small per-URL
    // slice. Falls back to fetchTimeoutMs when neither is set (legacy path).
    const desired =
      ctx.antiBotFetchTimeoutMs ?? ctx.stageBudgetMs ?? ctx.fetchTimeoutMs;
    // Take the larger of the anti-bot budget and the narrow-set slice; never
    // less than the normal base budget.
    budget = Math.max(desired, narrow, ctx.fetchTimeoutMs);
  }
  // Never MORE than the stage budget — keeps the overall stage bounded so the
  // stage timer (not an unbounded per-URL timer) caps wall-clock.
  return ctx.stageBudgetMs !== undefined
    ? Math.min(budget, ctx.stageBudgetMs)
    : budget;
}

/**
 * Render mode for a single enrichment fetch. Defaults to `'auto'` (the router
 * decides HTTP-first vs browser on runtime signals — today's fast path). When
 * {@link FetchContentContext.renderNarrowSet} is set AND the candidate set is
 * narrow (`candidateCount` ≤ `maxCandidates`), force `'always'` so a JS-heavy
 * SPA is rendered by the browser engine instead of yielding an empty HTTP
 * shell. `'always'` routes straight to the browser pool inside the router —
 * bypassing the HTTP/TLS-impersonation tiers — so no fetch-option threading
 * through those tiers is needed. A WIDE set (or absent config) keeps `'auto'`.
 */
function renderModeFor(ctx: FetchContentContext): 'auto' | 'always' {
  if (ctx.renderNarrowSet === undefined || ctx.candidateCount === undefined) {
    return 'auto';
  }
  return ctx.candidateCount <= ctx.renderNarrowSet.maxCandidates ? 'always' : 'auto';
}

// Timeout-class fetch_failed reasons that qualify for snippet fallback. A slow
// page that timed out still has usable snippet evidence; a hard failure (403,
// 404, DNS) does not, so the fallback is deliberately scoped to timeouts.
const TIMEOUT_FLAGS = new Set(['timeout', 'stage_timeout', 'total_timeout']);

/** Map an abort/error reason to the fetch_failed flag value. */
function reasonToFlag(reason: unknown): string {
  if (reason instanceof DOMException) {
    if (reason.message === 'stage_timeout') return 'stage_timeout';
    if (reason.message === 'timeout' || reason.name === 'TimeoutError') return 'timeout';
  }
  return reason instanceof Error ? reason.message : String(reason);
}

async function doFetchAndExtract(
  url: string,
  router: SmartRouter,
  ctx: FetchContentContext,
  signal: AbortSignal,
): Promise<string> {
  const raw = await router.fetch(url, {
    renderJs: renderModeFor(ctx),
    signal,
    ...(ctx.forceRefresh && { force_refresh: true }),
  });
  const extractor = await getExtractProvider();
  const extraction = await extractor.extract(raw.html, raw.finalUrl, {
    maxChars: ctx.contentMaxChars,
    contentType: raw.contentType,
  });

  try {
    cacheContent(raw, extraction);
  } catch (err) {
    log.warn('failed to cache search result', { url, error: String(err) });
  }

  try {
    const embeddingService = getEmbeddingService();
    if (embeddingService.isAvailable()) {
      embeddingService.embedAsync(raw.finalUrl, extraction.markdown);
    }
  } catch (err) {
    log.debug('embedding hook skipped for search result', { error: String(err) });
  }

  return ctx.maxContentChars !== undefined
    ? truncateSmartly(extraction.markdown, ctx.maxContentChars)
    : extraction.markdown;
}

async function fetchOne(
  url: string,
  router: SmartRouter,
  ctx: FetchContentContext,
  stageSignal: AbortSignal,
): Promise<SingleFetch> {
  if (Date.now() >= ctx.totalDeadline) {
    return { error: 'total_timeout' };
  }
  if (stageSignal.aborted) {
    return { error: reasonToFlag(stageSignal.reason) };
  }

  const perUrl = timeoutSignal(perUrlBudgetFor(url, ctx), 'timeout');
  const { signal, cleanup } = anySignal([stageSignal, perUrl.signal]);

  const work = doFetchAndExtract(url, router, ctx, signal);
  // Suppress unhandledRejection on the losing race leg — the winner is what
  // we surface; the loser must not surface as an unhandled rejection.
  work.catch(() => {});

  try {
    const content = await Promise.race([work, abortRejection(signal)]);
    return { content };
  } catch (err) {
    const msg = reasonToFlag(err);
    log.debug('content fetch failed', { url, error: msg });
    return { error: msg };
  } finally {
    perUrl.cancel();
    cleanup();
  }
}

// Parallel fetch all URLs; then apply total-char budget in relevance (input)
// order. Mutates each SearchResultItem in place with markdown_content, or
// fetch_failed/content_truncated metadata when applicable.
//
// When `max_fetches > 1` and one of the top-N parallel
// fetches fails, attempt fallback fetches from `results[maxFetches..]`
// within the remaining timeout budget. One backup attempt per failed slot
// — keeps the total successful-fetch count from exceeding the cap (so
// `max_fetches: N` still means "at most N pages of content") while
// healing transient timeouts on the top candidate. `max_fetches: 1` is
// deliberately exempt: the user asked for exactly one, no fallback.
export async function fetchContentForResults(
  results: SearchResultItem[],
  router: SmartRouter,
  ctx: FetchContentContext,
): Promise<void> {
  const cap = ctx.maxFetches !== undefined ? ctx.maxFetches : results.length;
  const fetchTargets = results.slice(0, cap);
  const attempted = new Set<string>(fetchTargets.map((r) => r.url));

  // Stage controller: aborts all fetches when stageBudgetMs elapses, before
  // the totalDeadline fires. When stageBudgetMs is absent the stageDeadline
  // equals totalDeadline and no extra timer fires — legacy path is preserved.
  const stageController = new AbortController();
  const stageDeadline =
    ctx.stageBudgetMs !== undefined
      ? Math.min(ctx.totalDeadline, Date.now() + ctx.stageBudgetMs)
      : ctx.totalDeadline;

  let stageTimer: ReturnType<typeof setTimeout> | undefined;
  if (ctx.stageBudgetMs !== undefined) {
    const delay = Math.max(0, stageDeadline - Date.now());
    stageTimer = setTimeout(
      () => stageController.abort(new DOMException('stage_timeout', 'AbortError')),
      delay,
    );
    if (typeof stageTimer.unref === 'function') stageTimer.unref();
  }

  try {
    const fetched = await Promise.all(
      fetchTargets.map((r) => fetchOne(r.url, router, ctx, stageController.signal)),
    );

    // Track which backup URL (if any) filled each failed slot. The backup's
    // content lands in the backup's own SearchResultItem (preserving the
    // failed slot's diagnostic info) — callers can then see both the
    // attempted failure and the substitute success.
    //
    // Wave strategy: count how many top slots still need a backup, then fire
    // that many deeper-candidate fetches IN PARALLEL. If some of those waves
    // also fail, repeat with the next batch. This preserves the
    // "no more than `cap` successful fetches" invariant while keeping wall-
    // clock close to a single fetch duration — slot-by-slot serialization
    // would multiply latency by the number of failed slots.
    if (cap > 1 && results.length > cap) {
      const originalFailedCount = fetched.filter((f) => f.content === undefined).length;
      let backupsAccepted = 0;
      let nextBackupIdx = cap;
      while (
        Date.now() < stageDeadline &&
        nextBackupIdx < results.length &&
        backupsAccepted < originalFailedCount
      ) {
        const stillNeeded = originalFailedCount - backupsAccepted;

        // Collect the next wave of backup candidates, dedup-protected and
        // bounded by remaining results.length.
        const wave: SearchResultItem[] = [];
        while (wave.length < stillNeeded && nextBackupIdx < results.length) {
          const candidate = results[nextBackupIdx];
          nextBackupIdx++;
          if (attempted.has(candidate.url)) continue;
          attempted.add(candidate.url);
          wave.push(candidate);
        }
        if (wave.length === 0) break;

        const waveResults = await Promise.all(
          wave.map((r) => fetchOne(r.url, router, ctx, stageController.signal)),
        );

        // Promote successful backups into fetchTargets / fetched. The order
        // of insertion mirrors the wave order, which keeps the relevance-
        // ordered char-budget loop below deterministic.
        for (let i = 0; i < wave.length; i++) {
          if (waveResults[i].content === undefined) continue;
          if (backupsAccepted >= originalFailedCount) break; // never overshoot cap
          fetchTargets.push(wave[i]);
          fetched.push(waveResults[i]);
          backupsAccepted++;
        }
      }
    }

    let totalCharsUsed = 0;
    for (let i = 0; i < fetchTargets.length; i++) {
      const result = fetchTargets[i];
      const { content, error } = fetched[i];

      if (error) {
        result.fetch_failed = error;
        // On a timeout the extracted page never arrived, but the result's own
        // snippet is real evidence text — surface it as content (flagged) so
        // callers get something instead of an empty field. Never fabricate: only
        // a non-empty existing snippet is promoted, and the failure stays
        // recorded. Scoped to timeout-class failures; hard failures pass empty.
        if (ctx.snippetFallback && TIMEOUT_FLAGS.has(error) && result.snippet) {
          result.markdown_content = result.snippet;
          result.content_from_snippet = true;
        }
        continue;
      }
      if (content === undefined) continue;

      if (totalCharsUsed >= ctx.maxTotalChars) {
        result.content_truncated = true;
        continue;
      }

      let out = content;
      const remaining = ctx.maxTotalChars - totalCharsUsed;
      if (out.length > remaining) {
        out = out.slice(0, remaining);
        result.content_truncated = true;
      }

      totalCharsUsed += out.length;
      result.markdown_content = out;
    }
  } finally {
    if (stageTimer !== undefined) clearTimeout(stageTimer);
    stageController.abort(); // cancel any stragglers
  }
}
