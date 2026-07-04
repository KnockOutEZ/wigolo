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
const { _resetBreakersForTest } = await import('../../../src/search/core/engine-base.js');

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
