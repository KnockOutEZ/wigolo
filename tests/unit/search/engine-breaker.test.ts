// Slice 4 (engine-pool recovery): breaker half-open state machine.
//
// WHY: during the 2026-06-12 benchmark two broken engines tripped their
// breakers and stayed dark for the whole run — the old breaker auto-reset
// after cooldown let EVERY caller retry at once (thundering herd) and gave
// no visibility into why an engine was missing. Half-open admits exactly
// one probe per cooldown window, backs off exponentially on probe failure
// (capped at 10 min), and exposes a snapshot for doctor/telemetry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../src/types.js';
import {
  wrapWithRetryAndBreaker,
  getBreakerSnapshot,
  BreakerOpenError,
  _resetBreakersForTest,
} from '../../../src/search/core/engine-base.js';

function makeResult(title: string): RawSearchResult {
  return {
    title,
    url: `https://example.com/${title}`,
    snippet: '',
    relevance_score: 1,
    engine: 'test',
  };
}

function makeEngine(
  name: string,
  behavior: (q: string, opts?: SearchEngineOptions) => Promise<RawSearchResult[]>,
): SearchEngine {
  return { name, search: behavior };
}

/** Start a wrapped call and flush the internal retry backoff timer.
 * Resolves to the result or the caught error. */
async function settleCall(
  wrapped: SearchEngine,
): Promise<RawSearchResult[] | unknown> {
  const p = wrapped.search('q').catch((e: unknown) => e);
  await vi.runAllTimersAsync();
  return p;
}

describe('breaker half-open state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetBreakersForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetBreakersForTest();
  });

  it('opens after 3 failures and rejects with BreakerOpenError carrying remaining cooldown ms', async () => {
    const spy = vi.fn(async () => {
      throw new Error('boom');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('hf1', spy), {
      failureThreshold: 3,
      cooldownMs: 60_000,
    });

    for (let i = 0; i < 3; i++) {
      const err = await settleCall(wrapped);
      expect(err).toBeInstanceOf(Error);
    }
    const callsBefore = spy.mock.calls.length;

    const rejection = await settleCall(wrapped);
    expect(rejection).toBeInstanceOf(BreakerOpenError);
    const breakerErr = rejection as BreakerOpenError;
    expect(breakerErr.cooldownRemainingMs).toBeGreaterThan(0);
    expect(breakerErr.cooldownRemainingMs).toBeLessThanOrEqual(60_000);
    // Tripped call must NOT reach the engine.
    expect(spy.mock.calls.length).toBe(callsBefore);
  });

  it('admits exactly one probe call after cooldown elapses', async () => {
    let calls = 0;
    const spy = vi.fn(async () => {
      calls++;
      if (calls <= 2) throw new Error('boom');
      return [makeResult('ok')];
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('hf2', spy), {
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    await settleCall(wrapped); // 2 attempts -> trips
    expect(spy).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60_000);

    // Probe passes through to the engine and succeeds.
    const results = await settleCall(wrapped);
    expect(results).toEqual([makeResult('ok')]);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('rejects concurrent callers as open while the probe is in flight', async () => {
    let release: ((r: RawSearchResult[]) => void) | undefined;
    let calls = 0;
    const spy = vi.fn(async (): Promise<RawSearchResult[]> => {
      calls++;
      if (calls <= 2) throw new Error('boom');
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('hf3', spy), {
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    await settleCall(wrapped); // trip
    vi.advanceTimersByTime(60_000);

    // Probe starts and hangs on the engine promise.
    const probePromise = wrapped.search('q');
    expect(spy).toHaveBeenCalledTimes(3);

    // Concurrent caller is rejected as open without touching the engine.
    await expect(wrapped.search('q')).rejects.toBeInstanceOf(BreakerOpenError);
    expect(spy).toHaveBeenCalledTimes(3);

    release!([makeResult('late')]);
    await expect(probePromise).resolves.toEqual([makeResult('late')]);
  });

  it('closes and resets trips/failures when the probe succeeds', async () => {
    let calls = 0;
    const spy = vi.fn(async () => {
      calls++;
      if (calls <= 2) throw new Error('boom');
      return [makeResult('ok')];
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('hf4', spy), {
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    await settleCall(wrapped); // trip
    vi.advanceTimersByTime(60_000);
    await settleCall(wrapped); // probe succeeds -> closed

    const snap = getBreakerSnapshot().find((s) => s.engine === 'hf4');
    expect(snap).toBeDefined();
    expect(snap!.state).toBe('closed');
    expect(snap!.failures).toBe(0);
    expect(snap!.cooldownRemainingMs).toBe(0);

    // Subsequent calls flow normally.
    const results = await settleCall(wrapped);
    expect(results).toEqual([makeResult('ok')]);
  });

  it('reopens with doubled cooldown when the probe fails', async () => {
    const spy = vi.fn(async () => {
      throw new Error('still down');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('hf5', spy), {
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    await settleCall(wrapped); // trip — open for 60s
    vi.advanceTimersByTime(60_000);

    await settleCall(wrapped); // probe fails -> reopen for 120s
    const callsAfterProbe = spy.mock.calls.length;

    // 60s later: still open (doubled cooldown not yet elapsed).
    vi.advanceTimersByTime(60_000);
    const rejection = await settleCall(wrapped);
    expect(rejection).toBeInstanceOf(BreakerOpenError);
    expect(spy.mock.calls.length).toBe(callsAfterProbe);

    // At 120s past the reopen: half-open again — probe reaches the engine.
    vi.advanceTimersByTime(60_000);
    await settleCall(wrapped);
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterProbe);
  });

  it('caps the backoff cooldown at 600000 ms', async () => {
    const spy = vi.fn(async () => {
      throw new Error('永 down');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('hf6', spy), {
      failureThreshold: 1,
      cooldownMs: 200_000,
    });

    await settleCall(wrapped); // trip — 200s
    vi.advanceTimersByTime(200_000);
    await settleCall(wrapped); // probe fail — 400s
    vi.advanceTimersByTime(400_000);
    await settleCall(wrapped); // probe fail — 800s, capped to 600s

    const snap = getBreakerSnapshot().find((s) => s.engine === 'hf6');
    expect(snap).toBeDefined();
    expect(snap!.state).toBe('open');
    expect(snap!.cooldownRemainingMs).toBeLessThanOrEqual(600_000);
    expect(snap!.cooldownRemainingMs).toBeGreaterThan(400_000);
  });

  it('captures lastError in the snapshot', async () => {
    const spy = vi.fn(async () => {
      throw new Error('upstream 403 forbidden');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('hf7', spy), {
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    await settleCall(wrapped);

    const snap = getBreakerSnapshot().find((s) => s.engine === 'hf7');
    expect(snap).toBeDefined();
    expect(snap!.lastError).toContain('upstream 403 forbidden');
  });
});
