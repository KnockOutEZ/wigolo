// Degraded-dispatch recovery wave (burst-load resilience, fix a + d).
//
// WHY: round-3 blind benchmark — once mojeek/marginalia breakers open
// mid-burst, error/brand queries collapsed to bing-only and quality cratered.
// The fix: when the PRIMARY dispatch wave leaves the pool degraded below a
// floor (healthy engines < half the roster), the orchestrator runs ONE
// recovery wave that dispatches the engines the primary wave did NOT use —
// the probe-only roster (mojeek, kept out of the normal wave because it is a
// perma-403 latency tax) plus any breaker-open engine now half-open. Recovery
// happens WITHIN the burst instead of waiting out the full cooldown.
//
// Gated PER-DISPATCH on the observed degraded predicate, never a query-wide
// boolean and never an engine name — a healthy pool must NOT trigger it.
// Deterministic — scripted engine mocks, no live network.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../src/types.js';
import type { EngineEntry } from '../../../src/search/core/engine-base.js';

const verticalState: {
  general: EngineEntry[];
  news: EngineEntry[];
  code: EngineEntry[];
  docs: EngineEntry[];
  papers: EngineEntry[];
  images: EngineEntry[];
} = { general: [], news: [], code: [], docs: [], papers: [], images: [] };

vi.mock('../../../src/search/core/verticals/general.js', () => ({
  getGeneralEngines: () => verticalState.general,
  _resetGeneralEnginesForTest: () => {
    verticalState.general = [];
  },
}));
vi.mock('../../../src/search/core/verticals/news.js', () => ({
  getNewsEngines: () => verticalState.news,
  _resetNewsEnginesForTest: () => {
    verticalState.news = [];
  },
}));
vi.mock('../../../src/search/core/verticals/code.js', () => ({
  getCodeEngines: () => verticalState.code,
  _resetCodeEnginesForTest: () => {
    verticalState.code = [];
  },
}));
vi.mock('../../../src/search/core/verticals/docs.js', () => ({
  getDocsEngines: () => verticalState.docs,
  _resetDocsEnginesForTest: () => {
    verticalState.docs = [];
  },
}));
vi.mock('../../../src/search/core/verticals/papers.js', () => ({
  getPapersEngines: () => verticalState.papers,
  _resetPapersEnginesForTest: () => {
    verticalState.papers = [];
  },
}));
vi.mock('../../../src/search/core/verticals/images.js', () => ({
  getImageEngines: () => verticalState.images,
  _resetImageEnginesForTest: () => {
    verticalState.images = [];
  },
}));

const { runV1Search } = await import('../../../src/search/core/orchestrator.js');
const {
  _resetBreakersForTest,
  wrapWithRetryAndBreaker,
  requestRecoveryProbe,
  getBreakerSnapshot,
  FORCED_PROBE_MIN_SPACING_MS,
} = await import('../../../src/search/core/engine-base.js');

function makeResult(engineName: string, url: string): RawSearchResult {
  return { title: `T ${url}`, url, snippet: 'S', relevance_score: 1, engine: engineName };
}

function healthyEntry(name: string, results: RawSearchResult[], extra: Partial<EngineEntry> = {}): EngineEntry {
  return {
    engine: { name, search: vi.fn(async (_q: string, _o?: SearchEngineOptions) => results) },
    quality: 'medium',
    ...extra,
  };
}

function emptyEntry(name: string, extra: Partial<EngineEntry> = {}): EngineEntry {
  return {
    engine: { name, search: vi.fn(async () => []) },
    quality: 'medium',
    ...extra,
  };
}

function probeOnlyEntry(name: string, results: RawSearchResult[]): EngineEntry {
  const spy = vi.fn(async (_q: string, _o?: SearchEngineOptions) => results);
  return { engine: { name, search: spy }, quality: 'low', secondary: true, probeOnly: true };
}

describe('degraded-dispatch recovery wave', () => {
  beforeEach(() => {
    verticalState.general = [];
    _resetBreakersForTest();
  });

  it('does NOT dispatch a probe-only engine in the primary wave when the pool is healthy', async () => {
    // NEGATIVE / must-not-fire: a healthy pool (>= half the roster returning
    // results) must never trigger recovery, so the probe-only engine's
    // search() is never called.
    const bing = healthyEntry('bing', [
      makeResult('bing', 'https://a.com/1'),
      makeResult('bing', 'https://a.com/2'),
    ]);
    const ddg = healthyEntry('ddg', [
      makeResult('ddg', 'https://b.com/1'),
      makeResult('ddg', 'https://b.com/2'),
    ]);
    const probe = probeOnlyEntry('mojeek', [makeResult('mojeek', 'https://probe.com/1')]);
    verticalState.general = [bing, ddg, probe];

    const out = await runV1Search({ query: 'healthy query', maxResults: 10 });

    expect(bing.engine.search).toHaveBeenCalled();
    expect(ddg.engine.search).toHaveBeenCalled();
    // Probe-only engine must stay dark on a healthy pool.
    expect(probe.engine.search).not.toHaveBeenCalled();
    // Its URL must NOT appear in the results.
    expect(out.results.some((r) => r.url === 'https://probe.com/1')).toBe(false);
  });

  it('dispatches the probe-only engine in a recovery wave when the primary pool degrades below floor', async () => {
    // The pool is starved: only ONE of three primary engines returns results
    // (healthy=1/3 < half). The probe-only engine (never in the primary wave)
    // is dispatched by the recovery wave and its good results reach the pool.
    const bing = healthyEntry('bing', [makeResult('bing', 'https://only.com/1')]);
    const ddgEmpty = emptyEntry('ddg');
    const wikiEmpty = emptyEntry('wikipedia');
    const probe = probeOnlyEntry('mojeek', [
      makeResult('mojeek', 'https://recovered.com/1'),
      makeResult('mojeek', 'https://recovered.com/2'),
    ]);
    verticalState.general = [bing, ddgEmpty, wikiEmpty, probe];

    const out = await runV1Search({ query: 'starved query', maxResults: 10 });

    // Recovery wave fired: probe-only engine was dispatched.
    expect(probe.engine.search).toHaveBeenCalled();
    // Its recovered results reach the merged pool.
    expect(out.results.some((r) => r.url === 'https://recovered.com/1')).toBe(true);
    // Pool degradation is surfaced honestly.
    expect(out.pool_degraded?.degraded).toBe(true);
    expect(out.pool_degraded?.reasons).toContain('degraded_recovery');
  });

  it('recovers a collapsed pool within the burst via the recovery wave', async () => {
    // The primary pool has collapsed to a single healthy engine (1 of 3, below
    // the floor of ceil(3/2)=2). The held-back probe-only engine feeds the
    // recovery wave and lifts the healthy count back above the collapse.
    const bing = healthyEntry('bing', [makeResult('bing', 'https://one.com/1')]);
    const ddgEmpty = emptyEntry('ddg');
    const wikiEmpty = emptyEntry('wikipedia');
    const brave = probeOnlyEntry('brave', [makeResult('brave', 'https://two.com/1')]);
    verticalState.general = [bing, ddgEmpty, wikiEmpty, brave];

    const out = await runV1Search({ query: 'burst recovery', maxResults: 10 });

    expect(brave.engine.search).toHaveBeenCalled();
    // Post-recovery the pool is no longer collapsed to a single engine.
    const healthy = out.outcomes.filter((o) => o.ok && o.results.length > 0).length;
    expect(healthy).toBeGreaterThanOrEqual(2);
  });

  it('degraded pool with a weak zero-lexical top is NOT normalised to 1.0 (gate d), recall preserved', async () => {
    // Gate (d) at the orchestrator seam: a degraded pool (1 of 3 healthy) whose
    // lone survivor returns a zero-lexical result must NOT have that result
    // stretched to relevance_score 1.0 by max-normalisation — that is the
    // live-incident ~1.0 mechanism. The orchestrator still RETURNS the result
    // (recall preserved here); the downstream core-provider floor is what
    // empties a purely-zero-lexical degraded pool. Proves the guard damps the
    // score without dropping recall at this layer.
    const survivor = healthyEntry('bing', [
      makeResult('bing', 'https://junk.example/jp'),
    ]);
    const ddgEmpty = emptyEntry('ddg');
    const wikiEmpty = emptyEntry('wikipedia');
    verticalState.general = [survivor, ddgEmpty, wikiEmpty];

    // Query shares NO token with the result's synthetic title/snippet.
    const out = await runV1Search({ query: 'kubernetes ingress controller', maxResults: 10 });
    const junk = out.results.find((r) => r.url === 'https://junk.example/jp');
    expect(junk).toBeDefined();
    // Not manufactured into a 1.0 evidence score on the degraded pool.
    expect(junk!.relevance_score).toBeLessThan(1);
  });

  it('degraded reasons enum: a degraded pool surfaces reason strings (recovery path)', async () => {
    // The pool_degraded.reasons enum is an open string[]; the degraded-recovery
    // wave contributes 'degraded_recovery'. (The downstream core-provider floor
    // adds 'no_lexical_match' for a purely-zero-lexical degraded pool — asserted
    // in the search-rerank-fold integration fixture, since the floor lives at
    // that seam, not in the orchestrator.)
    const bing = healthyEntry('bing', [makeResult('bing', 'https://only.com/1')]);
    const ddgEmpty = emptyEntry('ddg');
    const wikiEmpty = emptyEntry('wikipedia');
    const probe = probeOnlyEntry('mojeek', [makeResult('mojeek', 'https://recovered.com/1')]);
    verticalState.general = [bing, ddgEmpty, wikiEmpty, probe];

    const out = await runV1Search({ query: 'starved reasons query', maxResults: 10 });
    expect(out.pool_degraded?.reasons).toContain('degraded_recovery');
  });

  it('surfaces thin_pool (advisory) when only 2 engines contribute but the pool has NOT collapsed', async () => {
    // WHY: from a datacenter IP several engines are reachable but return zero
    // for a given query, so the pool honestly thins to 1–2 CONTRIBUTING engines
    // WITHOUT falling below the collapse floor. RRF then runs with weak cross-
    // engine voting, which is exactly the band where a single-engine off-topic
    // hit can survive (the reproduced runtime.tv leak). The advisory `thin_pool`
    // reason tells the caller/agent the results came from a thinned pool. Here 2
    // of 5 primary engines contribute (healthy=2 == floor ceil(5/2)=3? no:
    // ceil(5/2)=3, so 2 < 3 would be COLLAPSE) — so we dispatch 4 to keep the
    // floor at 2 and have exactly 2 contributors: floor ceil(4/2)=2, healthy=2,
    // NOT < floor, so not collapsed; healthy <= THIN_POOL_MAX_CONTRIBUTORS(2).
    const bing = healthyEntry('bing', [makeResult('bing', 'https://a.com/1')]);
    const ddg = healthyEntry('ddg', [makeResult('ddg', 'https://b.com/1')]);
    const wikiEmpty = emptyEntry('wikipedia');
    const margEmpty = emptyEntry('marginalia');
    verticalState.general = [bing, ddg, wikiEmpty, margEmpty];

    const out = await runV1Search({ query: 'thin pool query', maxResults: 10 });

    expect(out.pool_degraded?.degraded).toBe(true);
    expect(out.pool_degraded?.reasons).toContain('thin_pool');
    // Must NOT be mislabelled as a collapse — that reason engages the
    // downstream junk-floor emptying gate and must stay reserved for a real
    // collapse.
    expect(out.pool_degraded?.reasons).not.toContain('pool_collapsed');
  });

  it('does NOT surface thin_pool when a healthy pool has one routinely-empty engine (7 of 8 healthy)', async () => {
    // NEGATIVE / must-not-fire: a single routinely-empty engine (Wikipedia
    // returning 0 for a multi-word query) leaves 7 of 8 contributing — an
    // excellent pool. The old `< dispatched` trigger wrongly flagged this on
    // almost every real query; the absolute-contributor threshold must not.
    const entries: EngineEntry[] = [];
    for (let i = 0; i < 7; i++) {
      entries.push(healthyEntry(`e${i}`, [makeResult(`e${i}`, `https://ok${i}.com/1`)]));
    }
    entries.push(emptyEntry('wikipedia'));
    verticalState.general = entries;

    const out = await runV1Search({ query: 'healthy pool one empty engine', maxResults: 10 });

    // 7 contributors is far above the thin threshold: no degraded object, no
    // thin_pool reason.
    expect(out.pool_degraded).toBeUndefined();
  });

  it('does NOT surface thin_pool for a fully-healthy small roster (≤2 engines, all contributing)', async () => {
    // NEGATIVE / must-not-fire for condition (b): a vertical whose entire
    // roster is 2 engines and BOTH return results is at its normal state, not a
    // degradation — even though the absolute contributor count (2) is at the
    // thin threshold. The "some engine dropped out" (`< dispatched`) half of the
    // predicate excludes it. Guards against flagging a small-but-healthy pool.
    const a = healthyEntry('bing', [makeResult('bing', 'https://a.com/1')]);
    const b = healthyEntry('ddg', [makeResult('ddg', 'https://b.com/1')]);
    verticalState.general = [a, b];

    const out = await runV1Search({ query: 'small healthy roster', maxResults: 10 });

    expect(out.pool_degraded).toBeUndefined();
  });

  it('does NOT surface thin_pool when every dispatched engine contributes results', async () => {
    // NEGATIVE / must-not-fire: a fully healthy pool (all dispatched engines
    // returned >= 1 result) is not thin, so no advisory reason and no
    // pool_degraded object at all.
    const bing = healthyEntry('bing', [makeResult('bing', 'https://a.com/1')]);
    const ddg = healthyEntry('ddg', [makeResult('ddg', 'https://b.com/1')]);
    const wiki = healthyEntry('wikipedia', [makeResult('wikipedia', 'https://c.com/1')]);
    verticalState.general = [bing, ddg, wiki];

    const out = await runV1Search({ query: 'fully healthy query', maxResults: 10 });

    expect(out.pool_degraded).toBeUndefined();
  });

  it('a collapsed pool surfaces pool_collapsed and NOT thin_pool (gates stay distinct)', async () => {
    // NEGATIVE for the thin gate: when the pool truly collapses (1 of 3 healthy,
    // below floor), the reason is pool_collapsed — the thin advisory must NOT
    // also fire, so the two bands never blur.
    const bing = healthyEntry('bing', [makeResult('bing', 'https://only.com/1')]);
    const ddgEmpty = emptyEntry('ddg');
    const wikiEmpty = emptyEntry('wikipedia');
    verticalState.general = [bing, ddgEmpty, wikiEmpty];

    const out = await runV1Search({ query: 'kubernetes ingress controller', maxResults: 10 });

    expect(out.pool_degraded?.reasons).toContain('pool_collapsed');
    expect(out.pool_degraded?.reasons).not.toContain('thin_pool');
  });

  // Forced recovery probe: the recovery wave must be able to actually recover.
  //
  // WHY: the recovery wave re-dispatches every primary engine the wave recorded
  // as `skipped` — which is exactly the set whose breakers are OPEN. Milliseconds
  // later those breakers are still open, so the re-dispatch re-rejects without
  // touching the engine and the wave recovers nothing. In live dogfood this left
  // sessions pinned at {healthy: 1, total: 5, pool_collapsed} for their whole
  // duration: a single transient 403/429 became a session-long single-engine
  // pool, because nothing could reach the engine again until a full (and
  // exponentially growing) cooldown elapsed.
  //
  // The recovery wave therefore requests a BOUNDED forced half-open probe on the
  // breaker-open engines it is about to re-dispatch. Bounded two ways: it only
  // runs when the pool has actually collapsed, and it is spaced per engine by
  // FORCED_PROBE_MIN_SPACING_MS.
  it('forces a bounded half-open probe so the recovery wave can recover a breaker-open engine', async () => {
    let upstreamDown = true;
    const inner = vi.fn(async () => {
      if (upstreamDown) throw new Error('403 forbidden');
      return [makeResult('marginalia', 'https://recovered-engine.com/1')];
    });
    const marginalia = wrapWithRetryAndBreaker(
      { name: 'marginalia', search: inner },
      { failureThreshold: 1, cooldownMs: 60_000, retryAttempts: 1 },
    );

    // Trip the breaker on a transient upstream failure. It is now open for 60s.
    await expect(marginalia.search('warmup')).rejects.toThrow('403 forbidden');
    expect(getBreakerSnapshot().find((b) => b.engine === 'marginalia')?.state).toBe('open');
    expect(inner).toHaveBeenCalledTimes(1);

    // The upstream recovers immediately — the block was transient. Nothing but
    // our own breaker is keeping this engine out of the pool now.
    upstreamDown = false;

    const bing = healthyEntry('bing', [makeResult('bing', 'https://one.com/1')]);
    const ddgEmpty = emptyEntry('ddg');
    verticalState.general = [bing, ddgEmpty, { engine: marginalia, quality: 'medium' }];

    // Primary wave: bing contributes, ddg is empty, marginalia is skipped by its
    // open breaker -> healthy 1 of 3, below floor ceil(3/2)=2 -> collapse ->
    // recovery wave.
    const out = await runV1Search({ query: 'recovered engine query', maxResults: 10 });

    // The recovery wave must actually reach the engine, not just re-reject it.
    expect(inner).toHaveBeenCalledTimes(2);
    expect(out.results.some((r) => r.url === 'https://recovered-engine.com/1')).toBe(true);
    // Pre/post on the breaker itself: asserted 'open' above, closed here by the
    // probe's success. This is the open -> recovered transition the wave exists
    // to produce, and could not produce before.
    expect(getBreakerSnapshot().find((b) => b.engine === 'marginalia')?.state).toBe('closed');
  });

  it('NEGATIVE: a healthy pool never forces a recovery probe on a breaker-open engine', async () => {
    // Must-not-fire: forcing probes is only licensed by an actual collapse. A
    // healthy pool that happens to carry one breaker-open engine must leave that
    // breaker's cooldown alone — otherwise every search hammers a blocked engine.
    const inner = vi.fn(async () => {
      throw new Error('403 forbidden');
    });
    const marginalia = wrapWithRetryAndBreaker(
      { name: 'marginalia', search: inner },
      { failureThreshold: 1, cooldownMs: 60_000, retryAttempts: 1 },
    );
    await expect(marginalia.search('warmup')).rejects.toThrow('403 forbidden');
    expect(inner).toHaveBeenCalledTimes(1);

    // Three healthy engines keep the pool above the collapse floor even with
    // marginalia dark: healthy 3 of 4 >= ceil(4/2)=2.
    verticalState.general = [
      healthyEntry('bing', [makeResult('bing', 'https://a.com/1')]),
      healthyEntry('ddg', [makeResult('ddg', 'https://b.com/1')]),
      healthyEntry('wikipedia', [makeResult('wikipedia', 'https://c.com/1')]),
      { engine: marginalia, quality: 'medium' },
    ];

    await runV1Search({ query: 'healthy pool with one dark engine', maxResults: 10 });

    // Breaker untouched: the engine was never re-probed.
    expect(inner).toHaveBeenCalledTimes(1);
    expect(getBreakerSnapshot().find((b) => b.engine === 'marginalia')?.state).toBe('open');
  });

  it('spaces forced probes per engine so a collapsed pool cannot hammer a blocked engine', async () => {
    // The forced probe is bounded: once granted, the same engine cannot be
    // force-probed again until FORCED_PROBE_MIN_SPACING_MS has elapsed. Without
    // this bound, every call in a collapsed session would probe a hard-blocked
    // engine on every search.
    vi.useFakeTimers();
    try {
      const inner = vi.fn(async () => {
        throw new Error('403 forbidden');
      });
      const engine = wrapWithRetryAndBreaker(
        { name: 'spaced', search: inner },
        { failureThreshold: 1, cooldownMs: 60_000, retryAttempts: 1 },
      );
      await expect(engine.search('warmup')).rejects.toThrow('403 forbidden');
      expect(inner).toHaveBeenCalledTimes(1);

      // First request inside the cooldown is granted, and the probe it licenses
      // reaches the still-blocked engine and fails, reopening the breaker on a
      // longer backoff. This is the cycle a collapsed session actually runs.
      expect(requestRecoveryProbe('spaced')).toBe(true);
      await expect(engine.search('probe')).rejects.toThrow('403 forbidden');
      expect(inner).toHaveBeenCalledTimes(2);

      // A further request immediately after is refused — the spacing bound is
      // what stops every subsequent search in the collapsed session from
      // re-probing a hard-blocked engine.
      expect(requestRecoveryProbe('spaced')).toBe(false);

      // Still refused just under the spacing window.
      vi.advanceTimersByTime(FORCED_PROBE_MIN_SPACING_MS - 1);
      expect(requestRecoveryProbe('spaced')).toBe(false);
      expect(inner).toHaveBeenCalledTimes(2);

      // Granted again once the spacing window has elapsed.
      vi.advanceTimersByTime(2);
      expect(requestRecoveryProbe('spaced')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('NEGATIVE: requestRecoveryProbe is a no-op for an engine whose breaker is closed', async () => {
    // Must-not-fire: the forced probe only ever shortens an OPEN breaker's
    // cooldown. A healthy (closed) engine has no cooldown to shorten, so the
    // request is refused and no breaker state is invented for it.
    const inner = vi.fn(async () => [makeResult('closed', 'https://ok.com/1')]);
    const engine = wrapWithRetryAndBreaker({ name: 'closedEng', search: inner });
    await engine.search('q');

    expect(requestRecoveryProbe('closedEng')).toBe(false);
    expect(getBreakerSnapshot().find((b) => b.engine === 'closedEng')?.state).toBe('closed');
    // An engine that has never dispatched at all is likewise untouched.
    expect(requestRecoveryProbe('neverSeenEngine')).toBe(false);
    expect(getBreakerSnapshot().some((b) => b.engine === 'neverSeenEngine')).toBe(false);
  });

  it('does NOT re-dispatch good results away when the primary pool is healthy but thin on count', async () => {
    // NEGATIVE: two of two primary engines return results (healthy = 2/2 =
    // 100%). Even though max_results is high, the pool is NOT degraded, so no
    // recovery wave — the probe engine stays dark and the good results stand.
    const bing = healthyEntry('bing', [makeResult('bing', 'https://good.com/1')]);
    const ddg = healthyEntry('ddg', [makeResult('ddg', 'https://good.com/2')]);
    const probe = probeOnlyEntry('mojeek', [makeResult('mojeek', 'https://noise.com/1')]);
    verticalState.general = [bing, ddg, probe];

    const out = await runV1Search({ query: 'healthy thin query', maxResults: 10 });

    expect(probe.engine.search).not.toHaveBeenCalled();
    expect(out.results.some((r) => r.url === 'https://good.com/1')).toBe(true);
    expect(out.results.some((r) => r.url === 'https://good.com/2')).toBe(true);
    expect(out.results.some((r) => r.url === 'https://noise.com/1')).toBe(false);
  });
});
