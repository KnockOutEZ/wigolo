import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

export interface EngineEntry {
  engine: SearchEngine;
  /** Optional weight for downstream RRF/scoring. Default 1. */
  weight?: number;
  /** Whether this engine accepts date filters in options.fromDate/toDate. */
  supportsDateFilter?: boolean;
}

export interface EngineOutcome {
  engine: string;
  ok: boolean;
  results: RawSearchResult[];
  error?: string;
  latencyMs: number;
  /** True when the breaker tripped and we skipped the call. */
  skipped?: boolean;
}

export interface BreakerConfig {
  /** Fail count to trip. Default 3. */
  failureThreshold?: number;
  /** Cooldown after tripping, ms. Default 60_000. */
  cooldownMs?: number;
}

interface BreakerState {
  failures: number;
  tripUntil: number;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const RETRY_BACKOFF_MS = 100;

const breakers = new Map<string, BreakerState>();

function getState(name: string): BreakerState {
  let s = breakers.get(name);
  if (!s) {
    s = { failures: 0, tripUntil: 0 };
    breakers.set(name, s);
  }
  return s;
}

function isTripped(state: BreakerState): boolean {
  if (state.tripUntil === 0) return false;
  if (Date.now() >= state.tripUntil) {
    log.info('breaker auto-reset', { });
    state.tripUntil = 0;
    state.failures = 0;
    return false;
  }
  return true;
}

function recordFailure(name: string, threshold: number, cooldownMs: number): void {
  const state = getState(name);
  state.failures += 1;
  if (state.failures >= threshold && state.tripUntil === 0) {
    state.tripUntil = Date.now() + cooldownMs;
    log.warn('breaker tripped', {
      engine: name,
      failures: state.failures,
      cooldownMs,
    });
  }
}

function recordSuccess(name: string): void {
  const state = getState(name);
  state.failures = 0;
  state.tripUntil = 0;
}

export function _resetBreakersForTest(): void {
  breakers.clear();
}

class BreakerOpenError extends Error {
  constructor(name: string) {
    super(`breaker open for engine ${name}`);
    this.name = 'BreakerOpenError';
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
      if (isTripped(state)) {
        throw new BreakerOpenError(engine.name);
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

      recordFailure(engine.name, threshold, cooldownMs);
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
      const skipped = err instanceof BreakerOpenError;
      return {
        engine: entry.engine.name,
        ok: false,
        results: [],
        error: message,
        latencyMs: Date.now() - start,
        ...(skipped ? { skipped: true } : {}),
      };
    }
  });

  return Promise.all(promises);
}
