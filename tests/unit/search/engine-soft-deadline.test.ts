// Soft-deadline on parallel engine dispatch + session-scoped adaptive
// down-weight of chronically-tripped engines.
//
// WHY: the overall search response is a Promise.all over the engine pool, so
// it blocks on the SLOWEST engine. A straggler hanging toward its 10s abort
// budget drags the entire response to 10s even though the fast engines
// returned in <300ms. A soft-deadline caps that tail: once the deadline
// elapses, stragglers are recorded as timed-out and we stop blocking on them.
// A CHRONICALLY-tripped engine (many session trips) additionally gets a
// TIGHTER per-engine budget so we stop paying its cost every call — generic,
// data-driven (observed session trips), never keyed on an engine name. A
// transiently-slow-once engine must NOT be penalized, and a benched engine
// must still be able to recover.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../src/types.js';
import {
  runEnginesParallel,
  wrapWithRetryAndBreaker,
  getEngineSessionTrips,
  _resetBreakersForTest,
  type EngineEntry,
} from '../../../src/search/core/engine-base.js';

function makeResult(engine: string, url: string): RawSearchResult {
  return { title: 'T', url, snippet: '', relevance_score: 1, engine };
}

function fastEngine(name: string, results: RawSearchResult[]): EngineEntry {
  return {
    engine: {
      name,
      search: async () => results,
    },
  };
}

/** An engine whose search() resolves after `delayMs` (respecting fake timers). */
function slowEngine(name: string, delayMs: number, results: RawSearchResult[]): EngineEntry {
  return {
    engine: {
      name,
      search: (): Promise<RawSearchResult[]> =>
        new Promise((resolve) => setTimeout(() => resolve(results), delayMs)),
    },
  };
}

/** An engine that never settles — models a hung upstream connection. */
function hangingEngine(name: string): EngineEntry {
  return {
    engine: {
      name,
      search: (): Promise<RawSearchResult[]> => new Promise(() => {}),
    },
  };
}

describe('runEnginesParallel soft-deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetBreakersForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetBreakersForTest();
  });

  it('returns as soon as the soft deadline elapses without blocking on a hung engine', async () => {
    const entries: EngineEntry[] = [
      fastEngine('bing', [makeResult('bing', 'https://a.com/1')]),
      hangingEngine('marginalia'),
    ];

    const p = runEnginesParallel(entries, 'q', {}, { softDeadlineMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    const outcomes = await p;

    const bing = outcomes.find((o) => o.engine === 'bing');
    const marg = outcomes.find((o) => o.engine === 'marginalia');
    expect(bing?.ok).toBe(true);
    expect(bing?.results).toHaveLength(1);
    // The hung engine is recorded as a timed-out outcome, not awaited.
    expect(marg?.ok).toBe(false);
    expect(marg?.timedOut).toBe(true);
  });

  it('still collects a slow-but-within-deadline engine before returning', async () => {
    const entries: EngineEntry[] = [
      fastEngine('bing', [makeResult('bing', 'https://a.com/1')]),
      slowEngine('marginalia', 1_500, [makeResult('marginalia', 'https://b.com/1')]),
    ];

    const p = runEnginesParallel(entries, 'q', {}, { softDeadlineMs: 5_000 });
    await vi.advanceTimersByTimeAsync(1_500);
    const outcomes = await p;

    const marg = outcomes.find((o) => o.engine === 'marginalia');
    expect(marg?.ok).toBe(true);
    expect(marg?.timedOut).toBeUndefined();
    expect(marg?.results).toHaveLength(1);
  });

  it('resolves immediately once ALL engines settle, without waiting out the deadline', async () => {
    const entries: EngineEntry[] = [
      fastEngine('bing', [makeResult('bing', 'https://a.com/1')]),
      slowEngine('marginalia', 500, [makeResult('marginalia', 'https://b.com/1')]),
    ];

    const p = runEnginesParallel(entries, 'q', {}, { softDeadlineMs: 30_000 });
    await vi.advanceTimersByTimeAsync(500);
    const outcomes = await p;
    // Both settled well before the 30s deadline — no hang.
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  it('preserves legacy Promise.all behaviour when no soft deadline is given', async () => {
    const entries: EngineEntry[] = [
      fastEngine('bing', [makeResult('bing', 'https://a.com/1')]),
      slowEngine('marginalia', 3_000, [makeResult('marginalia', 'https://b.com/1')]),
    ];
    const p = runEnginesParallel(entries, 'q', {});
    await vi.advanceTimersByTimeAsync(3_000);
    const outcomes = await p;
    // Without a deadline we wait for the slow engine (no timedOut outcome).
    expect(outcomes.find((o) => o.engine === 'marginalia')?.ok).toBe(true);
    expect(outcomes.every((o) => o.timedOut === undefined)).toBe(true);
  });
});

describe('session-scoped adaptive down-weight of chronically-tripped engines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetBreakersForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetBreakersForTest();
  });

  async function settle(wrapped: SearchEngine): Promise<unknown> {
    const p = wrapped.search('q').catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    return p;
  }

  it('counts cumulative session trips that do NOT reset on an intervening success', async () => {
    // WHY: `state.trips` resets on success (it drives per-cooldown backoff).
    // Session trips must ACCUMULATE across recoveries so a flaky engine that
    // trips, recovers, trips again is recognised as chronically bad.
    let calls = 0;
    const spy = vi.fn(async () => {
      calls++;
      // Fail the first 2 (trips once at threshold 2), then succeed once, then
      // fail 2 more (trips again).
      if (calls <= 2) throw new Error('down');
      if (calls === 3) return [makeResult('e', 'https://ok/1')];
      throw new Error('down again');
    });
    const wrapped = wrapWithRetryAndBreaker({ name: 'flaky', search: spy }, {
      failureThreshold: 2,
      cooldownMs: 60_000,
      retryAttempts: 1,
    });

    await settle(wrapped); // fail
    await settle(wrapped); // fail -> trip #1
    expect(getEngineSessionTrips('flaky')).toBe(1);

    vi.advanceTimersByTime(60_000);
    await settle(wrapped); // probe succeeds -> closes; session trips PERSIST
    expect(getEngineSessionTrips('flaky')).toBe(1);

    await settle(wrapped); // fail
    await settle(wrapped); // fail -> trip #2
    expect(getEngineSessionTrips('flaky')).toBe(2);
  });

  it('does NOT mark a transiently-slow-once engine as chronically tripped', async () => {
    // A single trip is transient — session trips = 1 stays below the chronic
    // threshold so the engine keeps its full budget.
    const spy = vi.fn(async () => {
      throw new Error('one-time blip');
    });
    const wrapped = wrapWithRetryAndBreaker({ name: 'blip', search: spy }, {
      failureThreshold: 1,
      cooldownMs: 60_000,
      retryAttempts: 1,
    });
    await settle(wrapped); // single trip
    expect(getEngineSessionTrips('blip')).toBe(1);
  });

  it('_resetBreakersForTest clears session trips', async () => {
    const spy = vi.fn(async () => {
      throw new Error('down');
    });
    const wrapped = wrapWithRetryAndBreaker({ name: 'x', search: spy }, {
      failureThreshold: 1,
      cooldownMs: 60_000,
      retryAttempts: 1,
    });
    await settle(wrapped);
    expect(getEngineSessionTrips('x')).toBe(1);
    _resetBreakersForTest();
    expect(getEngineSessionTrips('x')).toBe(0);
  });
});

describe('chronically-tripped engine gets a tighter soft budget (generic, data-driven)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetBreakersForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetBreakersForTest();
  });

  it('drops a chronically-tripped hung engine at its reduced budget, well before the pool deadline', async () => {
    // Register the engine's session trips above the chronic threshold, then
    // dispatch it hung alongside a fast engine. Its reduced per-engine budget
    // must fire before the (much larger) pool soft deadline.
    const chronic = 'chronic-eng';
    // Force session trips high via a failing wrapped engine.
    const failing = wrapWithRetryAndBreaker(
      { name: chronic, search: async () => { throw new Error('down'); } },
      { failureThreshold: 1, cooldownMs: 60_000, retryAttempts: 1 },
    );
    // Trip it 3 times (crossing the chronic threshold of 3).
    for (let i = 0; i < 3; i++) {
      const p = failing.search('q').catch(() => {});
      await vi.runAllTimersAsync();
      await p;
      vi.advanceTimersByTime(600_000); // clear any cooldown for the next trip
    }
    expect(getEngineSessionTrips(chronic)).toBeGreaterThanOrEqual(3);

    const entries: EngineEntry[] = [
      fastEngine('bing', [makeResult('bing', 'https://a.com/1')]),
      hangingEngine(chronic),
    ];

    const p = runEnginesParallel(entries, 'q', {}, {
      softDeadlineMs: 30_000,
      chronicSoftDeadlineMs: 1_000,
    });
    // Advance only to the CHRONIC budget, not the pool deadline.
    await vi.advanceTimersByTimeAsync(1_000);
    const outcomes = await p;

    const c = outcomes.find((o) => o.engine === chronic);
    expect(c?.ok).toBe(false);
    expect(c?.timedOut).toBe(true);
    expect(outcomes.find((o) => o.engine === 'bing')?.ok).toBe(true);
  });

  it('a healthy engine (zero session trips) is NOT capped at the chronic budget', async () => {
    // NEGATIVE: a slow-but-healthy engine that is slower than the chronic
    // budget but faster than the pool deadline must still be collected.
    const entries: EngineEntry[] = [
      fastEngine('bing', [makeResult('bing', 'https://a.com/1')]),
      slowEngine('healthy', 2_000, [makeResult('healthy', 'https://b.com/1')]),
    ];
    expect(getEngineSessionTrips('healthy')).toBe(0);

    const p = runEnginesParallel(entries, 'q', {}, {
      softDeadlineMs: 30_000,
      chronicSoftDeadlineMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const outcomes = await p;

    const h = outcomes.find((o) => o.engine === 'healthy');
    expect(h?.ok).toBe(true);
    expect(h?.timedOut).toBeUndefined();
    expect(h?.results).toHaveLength(1);
  });
});
