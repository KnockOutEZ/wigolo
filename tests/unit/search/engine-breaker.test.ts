// Breaker half-open state machine.
//
// WHY: two broken engines tripped their
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
  getEngineSessionTrips,
  BreakerOpenError,
  resetBreakers,
  _resetBreakersForTest,
} from '../../../src/search/core/engine-base.js';
import {
  nextUserAgent,
  USER_AGENT_POOL,
} from '../../../src/search/engines/user-agents.js';

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

  it('caps the backoff cooldown at 180000 ms', async () => {
    // WHY: the old 600s (10-min) cap kept a hard-failing engine dark for ten
    // minutes — far longer than any realistic recovery window and long enough
    // to leave the pool depleted across a whole session. The cap is now 180s
    // (3 min): still a real backoff for a persistently-broken engine, but the
    // engine gets a fresh probe within a window a caller can wait out.
    const spy = vi.fn(async () => {
      throw new Error('永 down');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('hf6', spy), {
      failureThreshold: 1,
      cooldownMs: 100_000,
    });

    await settleCall(wrapped); // trip — 100s
    vi.advanceTimersByTime(100_000);
    await settleCall(wrapped); // probe fail — 200s, capped to 180s
    vi.advanceTimersByTime(180_000);
    await settleCall(wrapped); // probe fail — 400s, capped to 180s

    const snap = getBreakerSnapshot().find((s) => s.engine === 'hf6');
    expect(snap).toBeDefined();
    expect(snap!.state).toBe('open');
    // Capped exactly at 180s and not below the base cooldown.
    expect(snap!.cooldownRemainingMs).toBeLessThanOrEqual(180_000);
    expect(snap!.cooldownRemainingMs).toBeGreaterThan(100_000);
  });

  it('reclaims a stuck probe after the cooldown deadline so the engine is not dark forever', async () => {
    // WHY: a plugin engine whose search() never settles would otherwise hold
    // the breaker half-open permanently — `probing` stays true and every
    // later caller is rejected with no path back to a working engine.
    let calls = 0;
    const spy = vi.fn((): Promise<RawSearchResult[]> => {
      calls++;
      if (calls <= 2) return Promise.reject(new Error('boom'));
      if (calls === 3) return new Promise(() => {}); // probe hangs forever
      return Promise.resolve([makeResult('recovered')]);
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('hf8', spy), {
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    await settleCall(wrapped); // trip (calls 1-2)
    vi.advanceTimersByTime(60_000);

    // Probe admitted, hangs on the never-settling engine promise.
    void wrapped.search('q').catch(() => {});
    expect(spy).toHaveBeenCalledTimes(3);

    // Probe has been in flight for a full cooldown window — next caller
    // reclaims: stuck probe counts as failed, breaker reopens with backoff.
    vi.advanceTimersByTime(60_000);
    await expect(wrapped.search('q')).rejects.toBeInstanceOf(BreakerOpenError);
    expect(spy).toHaveBeenCalledTimes(3);

    const snap = getBreakerSnapshot().find((s) => s.engine === 'hf8');
    expect(snap).toBeDefined();
    expect(snap!.state).toBe('open');
    expect(snap!.cooldownRemainingMs).toBeGreaterThan(60_000); // backed off

    // After the reopened cooldown elapses the engine is recoverable: a new
    // probe is admitted and a now-healthy engine closes the breaker.
    vi.advanceTimersByTime(120_000);
    const results = await settleCall(wrapped);
    expect(results).toEqual([makeResult('recovered')]);
    const closed = getBreakerSnapshot().find((s) => s.engine === 'hf8');
    expect(closed!.state).toBe('closed');
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

  it('sanitizes control characters and caps length in lastError', async () => {
    // WHY: lastError flows into doctor output and telemetry — a hostile
    // upstream body echoed into an error message must not be able to emit
    // terminal escape sequences or unbounded text at the user's terminal.
    const spy = vi.fn(async () => {
      throw new Error(`\x1b[31mhostile\x1b[0m body ${'x'.repeat(2000)}`);
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('hf9', spy), {
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    await settleCall(wrapped);

    const snap = getBreakerSnapshot().find((s) => s.engine === 'hf9');
    expect(snap).toBeDefined();
    expect(snap!.lastError).toBeDefined();
    expect(snap!.lastError).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(snap!.lastError).toContain('hostile');
    expect(snap!.lastError!.length).toBeLessThanOrEqual(300);
  });
});

// Shared rotating user-agent pool.
//
// WHY: HTML-scraping engines (bing, duckduckgo, mojeek) 403 on IP/UA
// reputation. A single hardcoded UA can't recover; a fresh fingerprint on
// retry often clears the block. The pool is SHARED and applied by error
// class (403/blocked) across every HTML-scraping engine — not a per-engine
// special case — so the capability is pattern-level.
describe('shared user-agent pool', () => {
  it('exposes more than one browser-like user agent so retries can rotate', () => {
    expect(USER_AGENT_POOL.length).toBeGreaterThan(1);
    for (const ua of USER_AGENT_POOL) {
      expect(ua).toMatch(/Mozilla\/5\.0/);
    }
  });

  it('never returns the previous user agent so a retry gets a fresh fingerprint', () => {
    // WHY: the whole point of rotating on a 403 is a DIFFERENT fingerprint;
    // handing back the same UA would make the retry pointless.
    let prev: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < USER_AGENT_POOL.length * 3; i++) {
      const ua = nextUserAgent(prev);
      expect(ua).not.toBe(prev);
      seen.add(ua);
      prev = ua;
    }
    // Rotation cycles the whole pool, not just two entries.
    expect(seen.size).toBe(USER_AGENT_POOL.length);
  });

  it('returns a valid pool member even with no previous UA', () => {
    const ua = nextUserAgent(undefined);
    expect(USER_AGENT_POOL).toContain(ua);
  });
});

// In-call retry backoff + UA rotation on blocked errors.
//
// WHY: item 6 — the engine pool silently shrinks under load. The two gaps
// the audit flagged: (1) the in-call retry backoff was a FLAT 100ms, (2) a
// 403/blocked engine retried with the SAME fingerprint and stayed dark. The
// fix keeps the already-correct adaptive cooldown + half-open probe (proven
// above) and adds exponential in-call backoff + a UA-rotation hook driven by
// the engine-agnostic retry loop.
describe('adaptive in-call retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetBreakersForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetBreakersForTest();
  });

  it('grows the in-call backoff across attempts instead of a flat 100ms', async () => {
    // WHY: a flat 100ms retry hammers a rate-limited engine and rarely
    // clears a transient block. Backoff must GROW (100ms then ~300ms).
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
        if (typeof ms === 'number' && ms > 0) waits.push(ms);
        return (realSetTimeout as unknown as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      }) as unknown as typeof setTimeout);

    const spy = vi.fn(async () => {
      throw new Error('boom');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('rb1', spy), {
      failureThreshold: 10,
      cooldownMs: 60_000,
      retryAttempts: 3,
    });

    const p = wrapped.search('q').catch(() => undefined);
    await vi.runAllTimersAsync();
    await p;

    timeoutSpy.mockRestore();

    // 3 attempts => 2 inter-attempt backoffs, strictly increasing.
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits[0]).toBe(100);
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(waits[1]).toBe(300);
    // Engine was retried the full configured count.
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('defaults to two attempts with a 100ms backoff (legacy behaviour preserved)', async () => {
    // WHY: existing callers pass no retry config — the default retry loop
    // must stay a 2-attempt / 100ms shape so the breaker trip tests hold.
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
        if (typeof ms === 'number' && ms > 0) waits.push(ms);
        return (realSetTimeout as unknown as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      }) as unknown as typeof setTimeout);

    const spy = vi.fn(async () => {
      throw new Error('boom');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('rb2', spy), {
      failureThreshold: 10,
      cooldownMs: 60_000,
    });

    const p = wrapped.search('q').catch(() => undefined);
    await vi.runAllTimersAsync();
    await p;
    timeoutSpy.mockRestore();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([100]);
  });

  it('rotates to a different user agent on a 403/blocked retry via the engine onRetry hook', async () => {
    // WHY: IP/UA-reputation 403s often clear on a fresh fingerprint. The
    // retry loop is engine-agnostic, so it drives an optional onRetry hook;
    // an HTML-scraping engine rotates its UA there. Assert > 1 distinct UA
    // was observed across the attempts and that the SECOND attempt did not
    // reuse the FIRST attempt's UA.
    const observedUas: string[] = [];
    let currentUa = USER_AGENT_POOL[0];
    const engine = {
      name: 'rb3',
      async search(): Promise<RawSearchResult[]> {
        observedUas.push(currentUa);
        throw new Error('rb3 returned 403');
      },
      onRetry(_attempt: number, lastErr: unknown): void {
        // Rotate only for the blocked error class.
        if (lastErr instanceof Error && /\b403\b/.test(lastErr.message)) {
          currentUa = nextUserAgent(currentUa);
        }
      },
    };
    const wrapped = wrapWithRetryAndBreaker(engine, {
      failureThreshold: 10,
      cooldownMs: 60_000,
      retryAttempts: 3,
    });

    const p = wrapped.search('q').catch(() => undefined);
    await vi.runAllTimersAsync();
    await p;

    expect(observedUas.length).toBe(3);
    const distinct = new Set(observedUas);
    expect(distinct.size).toBeGreaterThan(1);
    expect(observedUas[1]).not.toBe(observedUas[0]);
  });

  it('does not invoke onRetry after the final attempt', async () => {
    // WHY: onRetry prepares the NEXT attempt; firing it after the last
    // attempt would rotate state with no call to use it.
    const onRetry = vi.fn();
    const engine = {
      name: 'rb4',
      search: vi.fn(async (): Promise<RawSearchResult[]> => {
        throw new Error('rb4 returned 403');
      }),
      onRetry,
    };
    const wrapped = wrapWithRetryAndBreaker(engine, {
      failureThreshold: 10,
      cooldownMs: 60_000,
      retryAttempts: 2,
    });

    const p = wrapped.search('q').catch(() => undefined);
    await vi.runAllTimersAsync();
    await p;

    // 2 attempts => onRetry fires exactly once (between attempt 1 and 2).
    expect(engine.search).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });
});

// D5 breaker tuning: 429 exemption from the exponential ladder, escapable
// chronic status, and a public reset.
//
// WHY: ~15 rapid queries tripped marginalia (429) and mojeek (403) breakers;
// because a 429 fed the SAME exponential trips/sessionTrips counters as a hard
// failure, the transient rate-limit backed off to the 10-minute cap and marked
// the engine chronically unhealthy — permanently, since sessionTrips never
// reset. A rate-limited engine is UP and throttling; it must recover on the
// short transient window and never poison the exponential ladder or the
// chronic-budget counter. Hard failures (403/5xx) keep their protective ladder.
describe('D5 breaker tuning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBreakers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetBreakers();
  });

  it('never trips the exponential ladder for repeated 429s — cooldown stays at the transient window', async () => {
    // POSITIVE: many consecutive 429 probe-failures must keep the SHORT
    // transient cooldown and never climb the exponential ladder toward the
    // hard-failure cap, and must never raise trips/sessionTrips.
    const spy = vi.fn(async () => {
      throw new Error('Upstream returned 429 too many requests');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('rl429', spy), {
      failureThreshold: 1,
      cooldownMs: 60_000,
      retryAttempts: 1,
    });

    await settleCall(wrapped); // trips — transient 5s window
    for (let i = 0; i < 6; i++) {
      // Elapse the transient window, then re-probe: still a 429.
      vi.advanceTimersByTime(5_000);
      await settleCall(wrapped);
    }

    const snap = getBreakerSnapshot().find((s) => s.engine === 'rl429')!;
    expect(snap.state).toBe('open');
    // Never escapes the transient window onto the exponential ladder.
    expect(snap.cooldownRemainingMs).toBeGreaterThan(0);
    expect(snap.cooldownRemainingMs).toBeLessThanOrEqual(5_000);
    // Rate-limit never feeds the chronic counter.
    expect(getEngineSessionTrips('rl429')).toBe(0);
  });

  it('caps a repeated-429 backoff at 30s even with a large base cooldown (boundary at the cap)', async () => {
    // POSITIVE boundary: a rate-limit cooldown is bounded by 30s regardless of
    // the caller's base cooldown — it must never inherit the exponential base.
    const spy = vi.fn(async () => {
      throw new Error('rate limit exceeded (429)');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('rl429cap', spy), {
      failureThreshold: 1,
      cooldownMs: 600_000, // large base — must not leak into the rate-limit path
      retryAttempts: 1,
    });

    await settleCall(wrapped); // trip
    // Probe repeatedly; each failure stays inside the transient/30s bound.
    for (let i = 0; i < 4; i++) {
      const cd = getBreakerSnapshot().find((s) => s.engine === 'rl429cap')!.cooldownRemainingMs;
      vi.advanceTimersByTime(cd + 1);
      await settleCall(wrapped);
      const snap = getBreakerSnapshot().find((s) => s.engine === 'rl429cap')!;
      expect(snap.cooldownRemainingMs).toBeLessThanOrEqual(30_000);
    }
    expect(getEngineSessionTrips('rl429cap')).toBe(0);
  });

  it('resets sessionTrips on a successful half-open recovery so chronic status is escapable', async () => {
    // A hard failure raises sessionTrips (chronic counter). Once the engine
    // recovers on a probe, sessionTrips must reset to 0 — chronic status is not
    // a life sentence.
    let calls = 0;
    const spy = vi.fn(async () => {
      calls++;
      if (calls <= 1) throw new Error('ECONNRESET socket hang up');
      return [makeResult('ok')];
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('recov', spy), {
      failureThreshold: 1,
      cooldownMs: 60_000,
      retryAttempts: 1,
    });

    await settleCall(wrapped); // hard trip
    expect(getEngineSessionTrips('recov')).toBe(1);

    vi.advanceTimersByTime(60_000);
    await settleCall(wrapped); // probe succeeds -> recovery

    expect(getEngineSessionTrips('recov')).toBe(0);
    const snap = getBreakerSnapshot().find((s) => s.engine === 'recov')!;
    expect(snap.state).toBe('closed');
  });

  it('NEGATIVE: a 403 (forbidden) still trips at threshold 3 and backs off exponentially to the 180s cap', async () => {
    // The protective ladder for hard failures is unchanged in kind: trips at
    // exactly 3 consecutive failures and climbs the exponential backoff, capped
    // at 180s, feeding sessionTrips each time.
    const spy = vi.fn(async () => {
      throw new Error('Upstream returned 403 forbidden');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('fb403', spy), {
      failureThreshold: 3,
      cooldownMs: 100_000,
      retryAttempts: 1,
    });

    // Two failures: not yet tripped.
    await settleCall(wrapped);
    await settleCall(wrapped);
    expect(getBreakerSnapshot().find((s) => s.engine === 'fb403')!.state).toBe('closed');

    // Third failure: trips at threshold 3, sessionTrips = 1.
    await settleCall(wrapped);
    let snap = getBreakerSnapshot().find((s) => s.engine === 'fb403')!;
    expect(snap.state).toBe('open');
    expect(getEngineSessionTrips('fb403')).toBe(1);

    // Failed probe -> exponential backoff, capped at 180s, sessionTrips climbs.
    vi.advanceTimersByTime(100_000);
    await settleCall(wrapped); // 200s -> capped 180s
    vi.advanceTimersByTime(180_000);
    await settleCall(wrapped); // 400s -> capped 180s

    snap = getBreakerSnapshot().find((s) => s.engine === 'fb403')!;
    expect(snap.state).toBe('open');
    expect(snap.cooldownRemainingMs).toBeLessThanOrEqual(180_000);
    expect(snap.cooldownRemainingMs).toBeGreaterThan(100_000);
    expect(getEngineSessionTrips('fb403')).toBe(3);
  });

  it('resetBreakers() clears the map so a previously-open engine is immediately dispatchable', async () => {
    let calls = 0;
    const spy = vi.fn(async () => {
      calls++;
      if (calls <= 3) throw new Error('boom');
      return [makeResult('after-reset')];
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('reset1', spy), {
      failureThreshold: 3,
      cooldownMs: 60_000,
      retryAttempts: 1,
    });

    await settleCall(wrapped);
    await settleCall(wrapped);
    await settleCall(wrapped); // tripped
    expect(getBreakerSnapshot().find((s) => s.engine === 'reset1')!.state).toBe('open');
    expect(getEngineSessionTrips('reset1')).toBe(1);

    resetBreakers();

    // Snapshot is empty and the next call reaches the engine immediately.
    expect(getBreakerSnapshot().find((s) => s.engine === 'reset1')).toBeUndefined();
    expect(getEngineSessionTrips('reset1')).toBe(0);
    const results = await settleCall(wrapped);
    expect(results).toEqual([makeResult('after-reset')]);
  });

  it('_resetBreakersForTest is a delegating alias for resetBreakers (importer stability)', () => {
    // WHY: 15 test files import _resetBreakersForTest; it must keep working as
    // an alias so renaming to the public resetBreakers causes zero churn.
    expect(_resetBreakersForTest).toBe(resetBreakers);
  });
});
