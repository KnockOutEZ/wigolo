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
}

export interface BreakerConfig {
  /** Fail count to trip. Default 3. */
  failureThreshold?: number;
  /** Cooldown after tripping, ms. Default 60_000. */
  cooldownMs?: number;
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
  /** Last engine error, surfaced via getBreakerSnapshot() for doctor. */
  lastError?: string;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 600_000;
const RETRY_BACKOFF_MS = 100;
const MAX_LAST_ERROR_LEN = 300;

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
    s = { failures: 0, tripUntil: 0, probing: false, probeStartedAt: 0, trips: 0 };
    breakers.set(name, s);
  }
  return s;
}

function recordFailure(name: string, threshold: number, cooldownMs: number): void {
  const state = getState(name);
  state.failures += 1;
  if (state.failures >= threshold && state.tripUntil === 0) {
    state.tripUntil = Date.now() + cooldownMs;
    state.trips = 1;
    log.warn('breaker tripped', {
      engine: name,
      failures: state.failures,
      cooldownMs,
    });
  }
}

/** Reopen after a failed (or stuck) probe: exponential backoff, capped. */
function reopenWithBackoff(state: BreakerState, cooldownMs: number): number {
  state.trips += 1;
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
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const results = await engine.search(query, options);
          recordSuccess(engine.name);
          return results;
        } catch (err) {
          lastErr = err;
          if (attempt === 1) {
            await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
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
        recordFailure(engine.name, threshold, cooldownMs);
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}

export async function runEnginesParallel(
  entries: EngineEntry[],
  query: string,
  options?: SearchEngineOptions,
): Promise<EngineOutcome[]> {
  const promises = entries.map(async (entry): Promise<EngineOutcome> => {
    const start = Date.now();
    try {
      const results = await entry.engine.search(query, options);
      return {
        engine: entry.engine.name,
        ok: true,
        results,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        engine: entry.engine.name,
        ok: false,
        results: [],
        error: message,
        latencyMs: Date.now() - start,
        ...(err instanceof BreakerOpenError
          ? { skipped: true, cooldownRemainingMs: err.cooldownRemainingMs }
          : {}),
      };
    }
  });

  return Promise.all(promises);
}
