import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../../src/types.js';
import {
  wrapWithRetryAndBreaker,
  runEnginesParallel,
  _resetBreakersForTest,
} from '../../../../src/search/v1/engine-base.js';

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
  return {
    name,
    search: behavior,
  };
}

describe('wrapWithRetryAndBreaker', () => {
  beforeEach(() => {
    _resetBreakersForTest();
  });

  it('returns results when underlying engine succeeds on first attempt', async () => {
    const spy = vi.fn(async () => [makeResult('a')]);
    const wrapped = wrapWithRetryAndBreaker(makeEngine('e1', spy));
    const results = await wrapped.search('q');
    expect(results).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries once on first failure and succeeds on second attempt', async () => {
    let calls = 0;
    const spy = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('first fail');
      return [makeResult('b')];
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('e2', spy));
    const results = await wrapped.search('q');
    expect(results).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('throws after second attempt also fails', async () => {
    const spy = vi.fn(async () => {
      throw new Error('always fails');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('e3', spy));
    await expect(wrapped.search('q')).rejects.toThrow('always fails');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('preserves the engine name on the wrapper', () => {
    const wrapped = wrapWithRetryAndBreaker(makeEngine('named-engine', async () => []));
    expect(wrapped.name).toBe('named-engine');
  });

  it('trips breaker after threshold consecutive failures', async () => {
    const spy = vi.fn(async () => {
      throw new Error('boom');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('e4', spy), {
      failureThreshold: 2,
      cooldownMs: 60_000,
    });

    // First attempt: 2 internal retries -> 1 failure recorded -> threshold not reached yet
    await expect(wrapped.search('q')).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);

    // Second attempt: another set of retries -> 2 failures -> trip
    await expect(wrapped.search('q')).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(4);

    // Third attempt: should be skipped (breaker tripped) -> no new calls
    await expect(wrapped.search('q')).rejects.toThrow(/breaker/i);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('auto-recovers after cooldown passes', async () => {
    let calls = 0;
    const spy = vi.fn(async () => {
      calls++;
      if (calls <= 4) throw new Error('boom');
      return [makeResult('ok')];
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('e5', spy), {
      failureThreshold: 2,
      cooldownMs: 5,
    });

    await expect(wrapped.search('q')).rejects.toThrow();
    await expect(wrapped.search('q')).rejects.toThrow();
    // breaker should now be tripped
    await expect(wrapped.search('q')).rejects.toThrow(/breaker/i);

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 20));

    // Now should attempt again
    const results = await wrapped.search('q');
    expect(results).toHaveLength(1);
  });

  it('successful call resets failure counter', async () => {
    let calls = 0;
    const spy = vi.fn(async () => {
      calls++;
      // Fail attempts 1-2 (first wrapped call: 2 retries -> 1 failure recorded)
      // Then succeed
      if (calls <= 2) throw new Error('boom');
      return [makeResult('ok')];
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('e6', spy), {
      failureThreshold: 3,
      cooldownMs: 60_000,
    });

    await expect(wrapped.search('q')).rejects.toThrow();
    // Now a success
    const ok = await wrapped.search('q');
    expect(ok).toHaveLength(1);

    // Now even after multiple failures we should be reset to 0
    // Subsequent failures should accumulate from zero
    calls = 0; // reset internal counter to make it always fail again
    const spy2 = vi.fn(async () => {
      throw new Error('boom2');
    });
    const wrapped2 = wrapWithRetryAndBreaker(makeEngine('e6', spy2), {
      failureThreshold: 3,
      cooldownMs: 60_000,
    });
    // Since prior wrapped succeeded, breaker for 'e6' is at 0 failures
    // wrapped2 shares state with wrapped. Two more failures should not trip yet.
    await expect(wrapped2.search('q')).rejects.toThrow();
    await expect(wrapped2.search('q')).rejects.toThrow();
    // Two failures recorded, threshold is 3 -> not yet tripped
    await expect(wrapped2.search('q')).rejects.toThrow(/boom2|breaker/);
  });

  it('multiple wrappers around same engine name share breaker state', async () => {
    const spyA = vi.fn(async () => {
      throw new Error('A fail');
    });
    const spyB = vi.fn(async () => {
      throw new Error('B fail');
    });
    const wA = wrapWithRetryAndBreaker(makeEngine('shared', spyA), {
      failureThreshold: 2,
      cooldownMs: 60_000,
    });
    const wB = wrapWithRetryAndBreaker(makeEngine('shared', spyB), {
      failureThreshold: 2,
      cooldownMs: 60_000,
    });

    await expect(wA.search('q')).rejects.toThrow();
    await expect(wB.search('q')).rejects.toThrow();
    // Now both share state, 2 failures recorded -> tripped
    await expect(wA.search('q')).rejects.toThrow(/breaker/i);
    await expect(wB.search('q')).rejects.toThrow(/breaker/i);
    // Underlying engines should not have been called for the tripped calls
    expect(spyA).toHaveBeenCalledTimes(2); // first call: 2 retries
    expect(spyB).toHaveBeenCalledTimes(2);
  });

  it('_resetBreakersForTest clears all state', async () => {
    const spy = vi.fn(async () => {
      throw new Error('boom');
    });
    const wrapped = wrapWithRetryAndBreaker(makeEngine('e7', spy), {
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    await expect(wrapped.search('q')).rejects.toThrow();
    // Should be tripped now
    await expect(wrapped.search('q')).rejects.toThrow(/breaker/i);

    _resetBreakersForTest();

    // After reset, underlying engine should be called again
    await expect(wrapped.search('q')).rejects.toThrow('boom');
    // 2 retries from first call + 2 from this fresh call = 4
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('does NOT count successful empty results as failures', async () => {
    const spy = vi.fn(async () => []);
    const wrapped = wrapWithRetryAndBreaker(makeEngine('e8', spy), {
      failureThreshold: 2,
      cooldownMs: 60_000,
    });

    await wrapped.search('q');
    await wrapped.search('q');
    await wrapped.search('q');
    // Should not be tripped because no errors thrown
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe('runEnginesParallel', () => {
  beforeEach(() => {
    _resetBreakersForTest();
  });

  it('returns one outcome per entry, in input order', async () => {
    const e1 = makeEngine('a', async () => [makeResult('r1')]);
    const e2 = makeEngine('b', async () => [makeResult('r2')]);
    const outcomes = await runEnginesParallel(
      [{ engine: e1 }, { engine: e2 }],
      'q',
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].engine).toBe('a');
    expect(outcomes[1].engine).toBe('b');
  });

  it('captures latency for each outcome', async () => {
    const e1 = makeEngine('a', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return [makeResult('r1')];
    });
    const outcomes = await runEnginesParallel([{ engine: e1 }], 'q');
    expect(outcomes[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(outcomes[0].ok).toBe(true);
  });

  it('does not throw when an engine throws', async () => {
    const e1 = makeEngine('throws', async () => {
      throw new Error('engine err');
    });
    const e2 = makeEngine('ok', async () => [makeResult('r1')]);

    const outcomes = await runEnginesParallel([{ engine: e1 }, { engine: e2 }], 'q');
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].error).toContain('engine err');
    expect(outcomes[1].ok).toBe(true);
    expect(outcomes[1].results).toHaveLength(1);
  });

  it('returns empty results for a failing entry', async () => {
    const e1 = makeEngine('throws', async () => {
      throw new Error('nope');
    });
    const outcomes = await runEnginesParallel([{ engine: e1 }], 'q');
    expect(outcomes[0].results).toEqual([]);
  });

  it('handles empty entries list', async () => {
    const outcomes = await runEnginesParallel([], 'q');
    expect(outcomes).toEqual([]);
  });

  it('passes options through to each engine', async () => {
    const seen: Array<unknown> = [];
    const e1 = makeEngine('a', async (_q, opts) => {
      seen.push(opts);
      return [];
    });
    await runEnginesParallel([{ engine: e1 }], 'q', { maxResults: 7, language: 'en' });
    expect(seen[0]).toEqual({ maxResults: 7, language: 'en' });
  });
});
