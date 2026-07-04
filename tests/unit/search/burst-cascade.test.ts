// Burst-load engine-pool resilience: failure-class breaker cooldowns +
// degraded-dispatch recovery.
//
// WHY: round-3 blind benchmark exposed engine-pool collapse under burst.
// mojeek 403s (reputational, persistent) and marginalia 429s (rate-limit,
// transient) tripped breakers with IDENTICAL 60s cooldowns that CASCADED
// across consecutive searches — within a burst the pool degraded to
// bing-only and result quality cratered. Two independent teeth here:
//
//   (c) A 429 (transient) breaker must recover FASTER than a 403
//       (reputational) breaker — the cooldown is failure-class-aware, keyed
//       on error class, never on an engine name.
//   (a) When a dispatch wave degrades below the pool floor AND some engines
//       were skipped (breaker open) or are probe-only, the orchestrator runs
//       ONE recovery wave that force-probes those engines so recovery happens
//       WITHIN the burst instead of being hostage to the full cooldown.
//
// Deterministic — engines are scripted mocks; no live network.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../src/types.js';
import {
  wrapWithRetryAndBreaker,
  getBreakerSnapshot,
  _resetBreakersForTest,
} from '../../../src/search/core/engine-base.js';

function makeResult(engine: string, url: string): RawSearchResult {
  return { title: 'T', url, snippet: '', relevance_score: 1, engine };
}

function makeEngine(
  name: string,
  behavior: (q: string, opts?: SearchEngineOptions) => Promise<RawSearchResult[]>,
): SearchEngine {
  return { name, search: behavior };
}

/** Start a wrapped call and flush the internal retry backoff timer. */
async function settleCall(wrapped: SearchEngine): Promise<RawSearchResult[] | unknown> {
  const p = wrapped.search('q').catch((e: unknown) => e);
  await vi.runAllTimersAsync();
  return p;
}

describe('failure-class-aware breaker cooldown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetBreakersForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetBreakersForTest();
  });

  it('a 429 (rate-limit) breaker recovers faster than a 403 (reputational) breaker', async () => {
    // Two engines trip at the same failure threshold + base cooldown. The
    // 429 engine (transient) must get a SHORTER cooldown than the 403 engine
    // (persistent) — so it is recoverable sooner within the same burst.
    const rateLimited = wrapWithRetryAndBreaker(
      makeEngine('rl', async () => {
        throw new Error('Upstream returned 429');
      }),
      { failureThreshold: 1, cooldownMs: 60_000, retryAttempts: 1 },
    );
    const forbidden = wrapWithRetryAndBreaker(
      makeEngine('fb', async () => {
        throw new Error('Upstream returned 403');
      }),
      { failureThreshold: 1, cooldownMs: 60_000, retryAttempts: 1 },
    );

    await settleCall(rateLimited); // trips
    await settleCall(forbidden); // trips

    const rl = getBreakerSnapshot().find((s) => s.engine === 'rl')!;
    const fb = getBreakerSnapshot().find((s) => s.engine === 'fb')!;
    expect(rl.state).toBe('open');
    expect(fb.state).toBe('open');
    // The 429 cooldown must be strictly shorter than the 403 cooldown.
    expect(rl.cooldownRemainingMs).toBeGreaterThan(0);
    expect(rl.cooldownRemainingMs).toBeLessThan(fb.cooldownRemainingMs);
  });

  it('a 429 breaker goes half-open before a 403 breaker does', async () => {
    // Concrete recovery-window proof: after advancing time past the SHORT
    // (429) cooldown but before the LONG (403) cooldown, the 429 engine is
    // half-open (recoverable) while the 403 engine is still open (dark).
    const rateLimited = wrapWithRetryAndBreaker(
      makeEngine('rl2', async () => {
        throw new Error('rl2 got 429 too many requests');
      }),
      { failureThreshold: 1, cooldownMs: 60_000, retryAttempts: 1 },
    );
    const forbidden = wrapWithRetryAndBreaker(
      makeEngine('fb2', async () => {
        throw new Error('fb2 got 403 forbidden');
      }),
      { failureThreshold: 1, cooldownMs: 60_000, retryAttempts: 1 },
    );

    await settleCall(rateLimited);
    await settleCall(forbidden);

    const rlCooldown = getBreakerSnapshot().find((s) => s.engine === 'rl2')!.cooldownRemainingMs;
    // Advance past the 429 cooldown but not past the 403 one.
    vi.advanceTimersByTime(rlCooldown + 1);

    const rl = getBreakerSnapshot().find((s) => s.engine === 'rl2')!;
    const fb = getBreakerSnapshot().find((s) => s.engine === 'fb2')!;
    expect(rl.state).toBe('half-open'); // cooldown elapsed, probe available
    expect(fb.state).toBe('open'); // still dark
  });

  it('an ordinary (non-classified) failure keeps the default cooldown', async () => {
    // NEGATIVE: a generic error that is neither 403 nor 429 must not get the
    // short transient cooldown — it keeps the caller-supplied default so the
    // existing breaker-trip contract is unchanged.
    const plain = wrapWithRetryAndBreaker(
      makeEngine('plain', async () => {
        throw new Error('ECONNRESET socket hang up');
      }),
      { failureThreshold: 1, cooldownMs: 60_000, retryAttempts: 1 },
    );
    await settleCall(plain);
    const snap = getBreakerSnapshot().find((s) => s.engine === 'plain')!;
    expect(snap.state).toBe('open');
    // Default cooldown, not the shortened transient one.
    expect(snap.cooldownRemainingMs).toBeGreaterThan(30_000);
    expect(snap.cooldownRemainingMs).toBeLessThanOrEqual(60_000);
  });
});
