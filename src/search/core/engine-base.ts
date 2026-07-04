import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

/**
 * Quality tier for an engine adapter. Reflects observed snippet quality +
 * stability of the upstream source. The tier is consumed to weight RRF
 * fusion — higher-tier engines contribute more to the fused ranking.
 *
 * Tier semantics (see also docs in src/search/core/engine-quality.ts):
 *   - 'high'   : authoritative source with structured payload (JSON/API),
 *                stable schema, rich snippets. Example: StackOverflow API,
 *                Wikipedia OpenSearch, MDN docs API.
 *   - 'medium' : scraped HTML or a structured feed where snippets are
 *                useful but can be thin or noisy. Example: Bing, DDG Lite,
 *                Brave web (description short), HN Algolia (points/comments
 *                fallback snippet), arXiv, Semantic Scholar (abstract may
 *                be missing).
 *   - 'low'    : sparse / boilerplate snippets, or a curated lookup that
 *                returns mostly metadata rather than evidence text. Example:
 *                devdocs (static slug table, no body content), lobsters
 *                (often returns "N score / N comments" rather than evidence).
 */
export type EngineQualityTier = 'high' | 'medium' | 'low';

export interface EngineEntry {
  engine: SearchEngine;
  /** Optional weight for downstream RRF/scoring. Default 1. */
  weight?: number;
  /** Whether this engine accepts date filters in options.fromDate/toDate. */
  supportsDateFilter?: boolean;
  /** Marks an engine as a low-priority secondary signal. Results that
   * were contributed only by secondary engines are demoted when their
   * lexical alignment with the query is low. Used by the code vertical
   * to admit MDN without letting it dominate database/library queries. */
  secondary?: boolean;
  /** Snippet / source-quality tier, consumed to weight RRF fusion. Every
   * registered entry MUST set a tier; a registered-engines test enforces
   * that the field is present. */
  quality?: EngineQualityTier;
  /** When true, the engine is registered but the orchestrator must skip
   * dispatch. Used when an upstream endpoint is gone or the adapter is
   * intentionally parked pending a rewrite — the slice spec calls this
   * out as a soft-disable so the adapter file isn't deleted (CEO call). */
  disabled?: boolean;
  /** When true, the engine is NOT dispatched in the primary wave — it is held
   * back and dispatched only by the orchestrator's degraded-recovery wave (see
   * orchestrator.ts) when the primary pool collapses below the health floor.
   * Used for an engine that is a per-call latency/failure tax on the happy path
   * (e.g. a source that reputation-blocks this network most of the time) but
   * still contributes an independent lexical signal when the pool is starved
   * and needs every engine it can get. Generic — no engine name is inspected
   * by the dispatch logic; the roster decides via this flag. */
  probeOnly?: boolean;
}

export interface EngineOutcome {
  engine: string;
  ok: boolean;
  results: RawSearchResult[];
  error?: string;
  latencyMs: number;
  /** True when the breaker tripped and we skipped the call. */
  skipped?: boolean;
  /** Remaining breaker cooldown in ms, set only when skipped. */
  cooldownRemainingMs?: number;
  /** True when the engine was still in flight at the pool's soft deadline
   * (or its tighter chronic budget) and was abandoned so a straggler could
   * not drag the overall response. Its underlying request keeps running and
   * its own abort timeout still fires; a late result may populate cache but
   * is not awaited. */
  timedOut?: boolean;
}

/** Options for {@link runEnginesParallel} that bound how long the pool waits. */
export interface RunEnginesOptions {
  /** Overall soft deadline in ms. Once elapsed, engines still in flight are
   * recorded as `timedOut` outcomes and no longer awaited. Undefined =
   * legacy Promise.all behaviour (wait for the slowest engine). */
  softDeadlineMs?: number;
  /** Tighter per-engine soft deadline applied ONLY to engines whose session
   * trip count is at/above the chronic threshold. Lets the pool stop paying a
   * chronically-failing engine's straggler cost every call while a healthy or
   * transiently-slow-once engine keeps the full pool deadline. Generic and
   * data-driven — keyed on observed session trips, never an engine name. */
  chronicSoftDeadlineMs?: number;
}

export interface BreakerConfig {
  /** Fail count to trip. Default 3. */
  failureThreshold?: number;
  /** Cooldown after tripping, ms. Default 60_000. */
  cooldownMs?: number;
  /** In-call retry attempts before the breaker records a failure. Default 2
   * (one retry). The inter-attempt backoff grows exponentially from the base
   * so a rate-limited engine is not hammered. */
  retryAttempts?: number;
}

/**
 * An engine that opts into the retry loop's rotation hook. The base
 * `SearchEngine` contract is unchanged — this optional method lets an
 * HTML-scraping adapter react to a retryable error (e.g. rotate its browser
 * fingerprint on a 403) before the next attempt. The retry loop calls it
 * only between attempts, never after the final one.
 */
export interface RetryableEngine extends SearchEngine {
  onRetry?(attempt: number, lastError: unknown): void;
}

interface BreakerState {
  failures: number;
  /** Epoch ms until which the breaker is open. 0 = closed. */
  tripUntil: number;
  /** Half-open probe in flight — concurrent callers are rejected as open. */
  probing: boolean;
  /** Epoch ms when the in-flight probe started — drives stuck-probe reclaim. */
  probeStartedAt: number;
  /** Consecutive opens without an intervening success — drives backoff. */
  trips: number;
  /** Cumulative trips over the process/session that do NOT reset on a
   * recovery. A single trip is transient; a high count marks an engine as
   * chronically unhealthy so the pool can give it a tighter wait budget. */
  sessionTrips: number;
  /** Last engine error, surfaced via getBreakerSnapshot() for doctor. */
  lastError?: string;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 600_000;
/** Session trips at/above this count mark an engine as chronically unhealthy.
 * The pool then applies the tighter `chronicSoftDeadlineMs` budget to it so a
 * repeatedly-failing engine stops draining wall-clock every call. A trip
 * happens at most once per cooldown window, so this many trips means the
 * engine has failed across several distinct recovery attempts — not a one-off
 * blip. Generic + data-driven; no engine name is special-cased. */
export const CHRONIC_TRIP_THRESHOLD = 3;
/** Base in-call retry backoff; grows exponentially per attempt (100ms, 300ms,
 * 900ms, …) so a rate-limited engine is not hammered on retry. */
const RETRY_BACKOFF_BASE_MS = 100;
const DEFAULT_RETRY_ATTEMPTS = 2;
const MAX_RETRY_BACKOFF_MS = 5_000;
const MAX_LAST_ERROR_LEN = 300;
/** A 429 / rate-limit block is TRANSIENT — the engine is up but throttling
 * this caller for a short window. It must recover FAST so a burst that
 * momentarily over-drives one engine doesn't lose it for a full minute. A 403
 * (reputational / forbidden) block is PERSISTENT and keeps the full cooldown.
 * The class is read from the error text — keyed on error class, never on an
 * engine name. Kept well above a single burst's inter-call gap so a genuinely
 * rate-limited engine still gets breathing room. */
const TRANSIENT_COOLDOWN_MS = 5_000;

export type FailureClass = 'rate-limit' | 'forbidden' | 'other';

/** Classify an engine failure by its error text. `rate-limit` (429 / "rate
 * limit" / "too many requests") is transient; `forbidden` (403 / "forbidden")
 * is a reputational block; everything else is `other`. Pure + engine-agnostic. */
export function classifyFailure(err: unknown): FailureClass {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b429\b/.test(message) || /rate.?limit|too many requests/.test(message)) {
    return 'rate-limit';
  }
  if (/\b403\b/.test(message) || /forbidden/.test(message)) return 'forbidden';
  return 'other';
}

/** Class-scaled cooldown: a transient (rate-limit) failure recovers on the
 * short window; a forbidden / other failure keeps the caller-supplied
 * cooldown. Never exceeds the base cooldown, so this can only SHORTEN a
 * cooldown, never extend it beyond what the caller configured. */
function cooldownForFailure(cls: FailureClass, baseCooldownMs: number): number {
  if (cls === 'rate-limit') return Math.min(TRANSIENT_COOLDOWN_MS, baseCooldownMs);
  return baseCooldownMs;
}

/** Upstream error bodies can echo hostile content into Error.message —
 * strip control chars (terminal escapes) and cap length before the string
 * reaches doctor output / telemetry. */
function sanitizeErrorMessage(message: string): string {
  return message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, MAX_LAST_ERROR_LEN);
}

const breakers = new Map<string, BreakerState>();

function getState(name: string): BreakerState {
  let s = breakers.get(name);
  if (!s) {
    s = { failures: 0, tripUntil: 0, probing: false, probeStartedAt: 0, trips: 0, sessionTrips: 0 };
    breakers.set(name, s);
  }
  return s;
}

function recordFailure(
  name: string,
  threshold: number,
  cooldownMs: number,
  failureClass: FailureClass,
): void {
  const state = getState(name);
  state.failures += 1;
  if (state.failures >= threshold && state.tripUntil === 0) {
    const effectiveCooldown = cooldownForFailure(failureClass, cooldownMs);
    state.tripUntil = Date.now() + effectiveCooldown;
    state.trips = 1;
    state.sessionTrips += 1;
    log.warn('breaker tripped', {
      engine: name,
      failures: state.failures,
      cooldownMs: effectiveCooldown,
      failureClass,
      sessionTrips: state.sessionTrips,
    });
  }
}

/** Reopen after a failed (or stuck) probe: exponential backoff, capped. */
function reopenWithBackoff(state: BreakerState, cooldownMs: number): number {
  state.trips += 1;
  state.sessionTrips += 1;
  const backoffMs = Math.min(cooldownMs * 2 ** (state.trips - 1), MAX_COOLDOWN_MS);
  state.tripUntil = Date.now() + backoffMs;
  state.probing = false;
  return backoffMs;
}

function recordSuccess(name: string): void {
  const state = getState(name);
  state.failures = 0;
  state.tripUntil = 0;
  state.probing = false;
  state.trips = 0;
  delete state.lastError;
}

export function _resetBreakersForTest(): void {
  breakers.clear();
}

/**
 * Cumulative breaker trips for an engine over the life of this process.
 * Unlike the per-cooldown `trips` counter, this does NOT reset when the
 * engine recovers — so a flaky engine that trips, recovers, and trips again
 * is recognised as chronically unhealthy. Pure read; 0 for an engine that
 * has never tripped (or never dispatched). */
export function getEngineSessionTrips(name: string): number {
  return breakers.get(name)?.sessionTrips ?? 0;
}

/** True when an engine has tripped enough times this session to be treated as
 * chronically unhealthy (see {@link CHRONIC_TRIP_THRESHOLD}). */
export function isEngineChronicallyUnhealthy(name: string): boolean {
  return getEngineSessionTrips(name) >= CHRONIC_TRIP_THRESHOLD;
}

export type BreakerSnapshotState = 'closed' | 'open' | 'half-open';

export interface BreakerSnapshotEntry {
  engine: string;
  state: BreakerSnapshotState;
  failures: number;
  cooldownRemainingMs: number;
  lastError?: string;
}

/**
 * Point-in-time view of every breaker that has seen at least one call.
 * `half-open` = cooldown elapsed but the breaker has not closed yet (probe
 * pending or in flight). Pure read — never mutates breaker state.
 */
export function getBreakerSnapshot(): BreakerSnapshotEntry[] {
  const now = Date.now();
  return [...breakers.entries()].map(([engine, s]) => {
    const state: BreakerSnapshotState =
      s.tripUntil === 0 ? 'closed' : now < s.tripUntil ? 'open' : 'half-open';
    return {
      engine,
      state,
      failures: s.failures,
      cooldownRemainingMs: state === 'open' ? s.tripUntil - now : 0,
      ...(s.lastError ? { lastError: s.lastError } : {}),
    };
  });
}

export class BreakerOpenError extends Error {
  readonly cooldownRemainingMs: number;

  constructor(name: string, cooldownRemainingMs: number) {
    super(`breaker open for engine ${name}`);
    this.name = 'BreakerOpenError';
    this.cooldownRemainingMs = cooldownRemainingMs;
  }
}

export function wrapWithRetryAndBreaker(
  engine: SearchEngine,
  cfg?: BreakerConfig,
): SearchEngine {
  const threshold = cfg?.failureThreshold ?? DEFAULT_THRESHOLD;
  const cooldownMs = cfg?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const retryAttempts = Math.max(1, cfg?.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);
  const onRetry = (engine as RetryableEngine).onRetry?.bind(engine);

  return {
    name: engine.name,
    async search(query: string, options?: SearchEngineOptions): Promise<RawSearchResult[]> {
      const state = getState(engine.name);
      let probe = false;
      if (state.tripUntil > 0) {
        const now = Date.now();
        if (now < state.tripUntil) {
          throw new BreakerOpenError(engine.name, state.tripUntil - now);
        }
        if (state.probing) {
          if (now - state.probeStartedAt >= cooldownMs) {
            // Stuck probe: in flight longer than a full cooldown window —
            // treat it as failed so a never-settling engine can't hold the
            // breaker half-open forever. Reopen with backoff; a later
            // caller re-probes once the new cooldown elapses.
            const backoffMs = reopenWithBackoff(state, cooldownMs);
            log.warn('breaker reclaimed stuck probe', {
              engine: engine.name,
              trips: state.trips,
              cooldownMs: backoffMs,
            });
            throw new BreakerOpenError(engine.name, backoffMs);
          }
          // Half-open admits exactly ONE probe — everyone else stays skipped
          // until the in-flight probe settles.
          throw new BreakerOpenError(engine.name, 0);
        }
        probe = true;
        state.probing = true;
        state.probeStartedAt = now;
        log.info('breaker half-open probe', { engine: engine.name });
      }

      let lastErr: unknown;
      for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        try {
          const results = await engine.search(query, options);
          recordSuccess(engine.name);
          return results;
        } catch (err) {
          lastErr = err;
          if (attempt < retryAttempts) {
            // Let the engine react to the retryable error before the next
            // attempt (e.g. rotate its browser fingerprint on a 403).
            onRetry?.(attempt, err);
            const backoffMs = Math.min(
              RETRY_BACKOFF_BASE_MS * 3 ** (attempt - 1),
              MAX_RETRY_BACKOFF_MS,
            );
            await new Promise((r) => setTimeout(r, backoffMs));
          }
        }
      }

      state.lastError = sanitizeErrorMessage(
        lastErr instanceof Error ? lastErr.message : String(lastErr),
      );
      if (probe) {
        // Failed probe — reopen with exponential backoff, capped at 10 min.
        const backoffMs = reopenWithBackoff(state, cooldownMs);
        log.warn('breaker reopened after failed probe', {
          engine: engine.name,
          trips: state.trips,
          cooldownMs: backoffMs,
        });
      } else {
        recordFailure(engine.name, threshold, cooldownMs, classifyFailure(lastErr));
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}

/** Unique sentinel so a soft-deadline win is distinguishable from a real
 * engine result — a plain value could collide with an engine's payload. */
const SOFT_DEADLINE = Symbol('soft-deadline');

export async function runEnginesParallel(
  entries: EngineEntry[],
  query: string,
  options?: SearchEngineOptions,
  runOptions?: RunEnginesOptions,
): Promise<EngineOutcome[]> {
  const softDeadlineMs = runOptions?.softDeadlineMs;
  const chronicSoftDeadlineMs = runOptions?.chronicSoftDeadlineMs;

  const promises = entries.map((entry): Promise<EngineOutcome> => {
    const name = entry.engine.name;
    const start = Date.now();
    const settled = entry.engine
      .search(query, options)
      .then(
        (results): EngineOutcome => ({
          engine: name,
          ok: true,
          results,
          latencyMs: Date.now() - start,
        }),
        (err): EngineOutcome => {
          const message = err instanceof Error ? err.message : String(err);
          return {
            engine: name,
            ok: false,
            results: [],
            error: message,
            latencyMs: Date.now() - start,
            ...(err instanceof BreakerOpenError
              ? { skipped: true, cooldownRemainingMs: err.cooldownRemainingMs }
              : {}),
          };
        },
      );

    // No soft deadline (or a zero/negative one): legacy behaviour — await the
    // engine directly so we wait for the slowest.
    if (!softDeadlineMs || softDeadlineMs <= 0) return settled;

    // A chronically-unhealthy engine gets the tighter budget; everyone else
    // gets the full pool deadline. Data-driven — no engine name is inspected.
    const budget =
      chronicSoftDeadlineMs !== undefined && isEngineChronicallyUnhealthy(name)
        ? Math.min(chronicSoftDeadlineMs, softDeadlineMs)
        : softDeadlineMs;

    // Prevent the abandoned engine promise from becoming an unhandled
    // rejection: its late error is swallowed here (the outcome is already
    // recorded as timedOut). A late SUCCESS still resolves and any cache
    // side-effects in the adapter already ran.
    settled.catch(() => {});

    let deadlineTimer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<typeof SOFT_DEADLINE>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(SOFT_DEADLINE), budget);
    });

    return Promise.race([settled, deadline]).then((r): EngineOutcome => {
      // Clear the deadline timer when the engine wins the race so a fast pool
      // doesn't leave dangling timers keeping the event loop (and a short-
      // lived CLI process) alive to the budget.
      clearTimeout(deadlineTimer);
      return r === SOFT_DEADLINE
        ? {
            engine: name,
            ok: false,
            results: [],
            error: 'soft-deadline timeout: engine did not respond within the pool budget',
            // latencyMs here is the pool's observed WAIT (≈ the budget), not
            // the engine's true response time — the request was abandoned in
            // flight and may still be running.
            latencyMs: Date.now() - start,
            timedOut: true,
          }
        : (r as EngineOutcome);
    });
  });

  return Promise.all(promises);
}
