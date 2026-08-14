// Throttle-as-skip: a per-engine minimum inter-request interval.
//
// WHY: ~15 rapid sequential queries over-drove marginalia into 429s, which
// (pre-D5) cascaded its breaker. The root cause is calling a rate-limit-prone
// engine faster than it tolerates. The fix is a per-engine minimum
// inter-request interval: a call arriving inside the interval SKIPS the engine
// rather than WAITING — waiting would poison the pool's soft deadlines and
// serialize multi-query fan-out. The skip rides the SAME skipped/error fields
// that a breaker-open uses (engine-base seam), so no downstream forwarding
// changes. Only rate-limit-prone engines are registered (marginalia: 2s);
// every other engine is unaffected.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../src/types.js';
import {
  wrapWithRetryAndBreaker,
  runEnginesParallel,
  resetBreakers,
  BreakerOpenError,
  ThrottledError,
  registerEngineMinInterval,
  MARGINALIA_MIN_INTERVAL_MS,
  type EngineEntry,
} from '../../../src/search/core/engine-base.js';

function makeResult(engine: string): RawSearchResult {
  return { title: 'T', url: `https://x/${engine}`, snippet: '', relevance_score: 1, engine };
}

function makeEngine(
  name: string,
  behavior: (q: string, opts?: SearchEngineOptions) => Promise<RawSearchResult[]>,
): SearchEngine {
  return { name, search: behavior };
}

describe('throttle-as-skip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBreakers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetBreakers();
  });

  it('registers marginalia with a 2s minimum inter-request interval', () => {
    expect(MARGINALIA_MIN_INTERVAL_MS).toBe(2_000);
  });

  it('skips (does not wait) when a throttled engine is called within its interval', async () => {
    const spy = vi.fn(async () => [makeResult('thr1')]);
    const wrapped = wrapWithRetryAndBreaker(makeEngine('thr1', spy), {
      minIntervalMs: 2_000,
    });

    // First call goes through.
    await expect(wrapped.search('q')).resolves.toEqual([makeResult('thr1')]);
    expect(spy).toHaveBeenCalledTimes(1);

    // A call 1s later is inside the interval -> SKIP (throttle error), no wait,
    // engine not touched.
    vi.advanceTimersByTime(1_000);
    const err = await wrapped.search('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThrottledError);
    // ThrottledError is a BreakerOpenError subclass so the pool maps it to a
    // skip on the existing fields.
    expect(err).toBeInstanceOf(BreakerOpenError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('resolves the skip WITHOUT waiting — no fake timer advance needed', async () => {
    // WHY: waiting would poison pool deadlines. The skip must reject
    // synchronously-fast, not after a delay. If the throttle waited, this
    // promise would hang under fake timers (no runAllTimersAsync here).
    const spy = vi.fn(async () => [makeResult('thr2')]);
    const wrapped = wrapWithRetryAndBreaker(makeEngine('thr2', spy), {
      minIntervalMs: 2_000,
    });
    await wrapped.search('q');
    vi.advanceTimersByTime(500);
    // No timer flush: a waiting implementation would never settle.
    await expect(wrapped.search('q')).rejects.toBeInstanceOf(ThrottledError);
  });

  it('is usable again once the interval elapses', async () => {
    const spy = vi.fn(async () => [makeResult('thr3')]);
    const wrapped = wrapWithRetryAndBreaker(makeEngine('thr3', spy), {
      minIntervalMs: 2_000,
    });

    await wrapped.search('q');
    vi.advanceTimersByTime(1_000);
    await expect(wrapped.search('q')).rejects.toBeInstanceOf(ThrottledError);

    // Elapse the full interval from the FIRST successful call.
    vi.advanceTimersByTime(1_001);
    await expect(wrapped.search('q')).resolves.toEqual([makeResult('thr3')]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('throttled outcome surfaces as skipped:true through runEnginesParallel', async () => {
    const spy = vi.fn(async () => [makeResult('thr4')]);
    const wrapped = wrapWithRetryAndBreaker(makeEngine('thr4', spy), {
      minIntervalMs: 2_000,
    });
    const entries: EngineEntry[] = [{ engine: wrapped }];

    // Warm the interval so the runEnginesParallel dispatch lands inside it.
    await wrapped.search('q');
    vi.advanceTimersByTime(500);

    const [outcome] = await runEnginesParallel(entries, 'q');
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBe(true);
    expect(outcome.results).toEqual([]);
  });

  it('NEGATIVE: an engine with no registered interval is never throttled', async () => {
    const spy = vi.fn(async () => [makeResult('free')]);
    const wrapped = wrapWithRetryAndBreaker(makeEngine('free', spy));

    for (let i = 0; i < 5; i++) {
      await expect(wrapped.search('q')).resolves.toEqual([makeResult('free')]);
    }
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('NEGATIVE: throttling one engine does not throttle a different engine', async () => {
    const throttledSpy = vi.fn(async () => [makeResult('a')]);
    const freeSpy = vi.fn(async () => [makeResult('b')]);
    const throttled = wrapWithRetryAndBreaker(makeEngine('thrA', throttledSpy), {
      minIntervalMs: 2_000,
    });
    const free = wrapWithRetryAndBreaker(makeEngine('freeB', freeSpy));

    await throttled.search('q');
    await free.search('q');
    vi.advanceTimersByTime(500);

    // thrA is inside its interval -> skip; freeB is untouched -> runs.
    await expect(throttled.search('q')).rejects.toBeInstanceOf(ThrottledError);
    await expect(free.search('q')).resolves.toEqual([makeResult('b')]);
    expect(freeSpy).toHaveBeenCalledTimes(2);
  });

  it('NEGATIVE: two different engines dispatch concurrently (pool not serialized)', async () => {
    // WHY: the throttle must never serialize multi-query fan-out. Two distinct
    // engines each with an interval run in the same wave without one blocking
    // the other.
    let inFlight = 0;
    let maxConcurrent = 0;
    const makeConcurrentEngine = (name: string) =>
      makeEngine(name, async (): Promise<RawSearchResult[]> => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await Promise.resolve();
        inFlight--;
        return [makeResult(name)];
      });
    const entries: EngineEntry[] = [
      { engine: wrapWithRetryAndBreaker(makeConcurrentEngine('c1'), { minIntervalMs: 2_000 }) },
      { engine: wrapWithRetryAndBreaker(makeConcurrentEngine('c2'), { minIntervalMs: 2_000 }) },
    ];

    const outcomes = await runEnginesParallel(entries, 'q');
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  // The throttle clock must only count requests that ACTUALLY went out.
  //
  // WHY: live dogfood showed "throttled: called within its minimum interval"
  // firing on an engine whose breaker was already open — i.e. we rate-limited
  // ourselves against requests we never sent. A breaker-open rejection costs
  // the engine nothing upstream, so it must not spend the engine's inter-request
  // budget. When it does, the budget is still burnt when the cooldown elapses
  // and the half-open probe is thrown away as "throttled" — turning one
  // transient failure into a longer dark window than the breaker policy chose.
  it('a breaker-open rejection does NOT consume the throttle budget', async () => {
    let fail = true;
    const spy = vi.fn(async () => {
      if (fail) throw new Error('boom');
      return [makeResult('thrOpen')];
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('thrOpen', spy), {
      minIntervalMs: 2_000,
      failureThreshold: 1,
      cooldownMs: 60_000,
      retryAttempts: 1,
    });

    // t=0: a REAL dispatch that fails -> breaker trips for 60s.
    await expect(wrapped.search('q')).rejects.toThrow('boom');
    expect(spy).toHaveBeenCalledTimes(1);

    // t=59.5s: still inside the cooldown. This call is rejected by the breaker
    // and NEVER reaches the engine, so it must not advance the throttle clock.
    vi.advanceTimersByTime(59_500);
    await expect(wrapped.search('q')).rejects.toBeInstanceOf(BreakerOpenError);
    expect(spy).toHaveBeenCalledTimes(1);

    // t=60.001s: the cooldown has elapsed, so this call is the half-open probe.
    // It is only 501ms after the breaker-open rejection above — if that
    // rejection had spent the throttle budget, the probe would be skipped as
    // throttled and the engine would stay dark for another full interval.
    fail = false;
    vi.advanceTimersByTime(501);
    await expect(wrapped.search('q')).resolves.toEqual([makeResult('thrOpen')]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a concurrent probe-loser does NOT consume the throttle budget', async () => {
    // WHY: half-open admits exactly ONE probe; every other concurrent caller is
    // rejected with BreakerOpenError(0) without touching the engine. Those
    // losers must not spend the interval either, or a burst of callers starves
    // the engine's next real dispatch.
    let release: (() => void) | undefined;
    let fail = true;
    let blockNext = false;
    const spy = vi.fn(async () => {
      if (fail) throw new Error('boom');
      if (blockNext) {
        blockNext = false;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return [makeResult('thrLoser')];
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('thrLoser', spy), {
      minIntervalMs: 2_000,
      failureThreshold: 1,
      cooldownMs: 60_000,
      retryAttempts: 1,
    });

    await expect(wrapped.search('q')).rejects.toThrow('boom');
    vi.advanceTimersByTime(60_001);

    // t=60.001s: first caller becomes the in-flight probe and blocks inside the
    // engine, so `probing` stays true for the rest of this test.
    fail = false;
    blockNext = true;
    const probe = wrapped.search('q');
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(2);

    // t=62.002s: a full interval after the probe's dispatch, so this caller
    // clears the throttle gate and reaches the breaker, which rejects it as a
    // probe-loser without touching the engine.
    vi.advanceTimersByTime(2_001);
    await expect(wrapped.search('q')).rejects.toBeInstanceOf(BreakerOpenError);
    expect(spy).toHaveBeenCalledTimes(2);

    // t=63.000s: settle the probe so the breaker closes. The throttle clock
    // must still read from the probe's dispatch at t=60.001s (2999ms ago), not
    // from the loser's rejection at t=62.002s (998ms ago). If the loser spent
    // the budget, this call is skipped as throttled.
    vi.advanceTimersByTime(998);
    release?.();
    await expect(probe).resolves.toEqual([makeResult('thrLoser')]);

    await expect(wrapped.search('q')).resolves.toEqual([makeResult('thrLoser')]);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('NEGATIVE: a request that DID go out still consumes the throttle budget', async () => {
    // Over-fire guard for the fix above: exempting rejections must not exempt
    // real dispatches. A failing call still reaches the engine, so it still
    // spends the interval — otherwise the throttle stops protecting the engine
    // exactly when it is failing.
    const spy = vi.fn(async () => {
      throw new Error('boom');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('thrSpend', spy), {
      minIntervalMs: 2_000,
      failureThreshold: 99,
      retryAttempts: 1,
    });

    await expect(wrapped.search('q')).rejects.toThrow('boom');
    expect(spy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    await expect(wrapped.search('q')).rejects.toBeInstanceOf(ThrottledError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('registerEngineMinInterval wires a default interval by engine name', async () => {
    // WHY: the general vertical registers marginalia's interval by name so the
    // wrapped engine picks it up without every call site passing minIntervalMs.
    registerEngineMinInterval('regEng', 2_000);
    const spy = vi.fn(async () => [makeResult('regEng')]);
    const wrapped = wrapWithRetryAndBreaker(makeEngine('regEng', spy));

    await wrapped.search('q');
    vi.advanceTimersByTime(500);
    await expect(wrapped.search('q')).rejects.toBeInstanceOf(ThrottledError);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
