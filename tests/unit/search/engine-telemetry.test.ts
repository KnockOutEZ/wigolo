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
} = { general: [], news: [], code: [], docs: [], papers: [] };

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

const { CoreSearchProvider } = await import('../../../src/search/core/core-provider.js');

function makeResult(engineName: string, url: string): RawSearchResult {
  return { title: 'T', url, snippet: 'S', relevance_score: 1, engine: engineName };
}

function makeEntry(name: string, results: RawSearchResult[]): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async (_q: string, _opts?: SearchEngineOptions) => results),
  };
  return { engine };
}

function makeFailingEntry(name: string): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async () => {
      throw new Error('boom');
    }),
  };
  return { engine };
}

beforeEach(() => {
  verticalState.general = [];
  verticalState.news = [];
  verticalState.code = [];
  verticalState.docs = [];
  verticalState.papers = [];
});

describe('engine_telemetry (sub-ticket 3.13)', () => {
  it('always emits engine_telemetry on SearchOutput', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://a.com/x'),
        makeResult('bing', 'https://b.com/x'),
      ]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Array.isArray(out.data.engine_telemetry)).toBe(true);
    const ent = out.data.engine_telemetry!.find((e) => e.name === 'bing');
    expect(ent).toBeDefined();
    expect(ent!.outcome).toBe('ok');
    expect(ent!.result_count).toBe(2);
    expect(typeof ent!.latency_ms).toBe('number');
    expect(typeof ent!.dedup_kept).toBe('number');
  });

  it('marks breaker-skipped engine with reason=breaker_open and remaining cooldown', async () => {
    // WHY: two engines can sit behind open breakers for a whole run with zero
    // caller-visible signal. `reason` + `cooldown_remaining_ms` make the
    // skip distinguishable from a plain error and tell callers when the
    // engine will be retried.
    const { BreakerOpenError } = await import('../../../src/search/core/engine-base.js');
    const breakerEngine: SearchEngine = {
      name: 'mojeek',
      search: vi.fn(async () => {
        throw new BreakerOpenError('mojeek', 42_000);
      }),
    };
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.com/x')]),
      { engine: breakerEngine },
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ent = out.data.engine_telemetry!.find((e) => e.name === 'mojeek');
    expect(ent).toBeDefined();
    expect(ent!.outcome).toBe('skipped');
    expect(ent!.reason).toBe('breaker_open');
    expect(ent!.cooldown_remaining_ms).toBe(42_000);
  });

  it('merges a breaker_open skip into an existing engine entry on multi-query', async () => {
    // WHY: multi-query aggregates per-dispatch outcomes by engine name. When
    // the same engine succeeds on one query and is breaker-skipped on the
    // next, the merge branch must mark the merged entry skipped and attach
    // reason/cooldown — otherwise the skip is invisible behind the ok row.
    const { BreakerOpenError } = await import('../../../src/search/core/engine-base.js');
    const flaky: SearchEngine = {
      name: 'mojeek',
      search: vi.fn(async (q: string) => {
        if (q === 'q1') return [makeResult('mojeek', 'https://m.com/x')];
        throw new BreakerOpenError('mojeek', 42_000);
      }),
    };
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.com/x')]),
      { engine: flaky },
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: ['q1', 'q2'], include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rows = out.data.engine_telemetry!.filter((e) => e.name === 'mojeek');
    expect(rows).toHaveLength(1); // aggregated, not one row per dispatch
    expect(rows[0].outcome).toBe('skipped');
    expect(rows[0].reason).toBe('breaker_open');
    expect(rows[0].cooldown_remaining_ms).toBe(42_000);
    expect(rows[0].result_count).toBe(1); // q1 results still counted
  });

  it('keeps the first-seen reason and cooldown when both dispatches are breaker-skipped', async () => {
    // First-seen-wins, mirroring how `error` merges: the earliest dispatch's
    // cooldown is the one callers saw first and the one closest to reality.
    const { BreakerOpenError } = await import('../../../src/search/core/engine-base.js');
    const cooldowns: Record<string, number> = { q1: 42_000, q2: 17_000 };
    const dark: SearchEngine = {
      name: 'mojeek',
      search: vi.fn(async (q: string) => {
        throw new BreakerOpenError('mojeek', cooldowns[q] ?? 0);
      }),
    };
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.com/x')]),
      { engine: dark },
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: ['q1', 'q2'], include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ent = out.data.engine_telemetry!.find((e) => e.name === 'mojeek');
    expect(ent).toBeDefined();
    expect(ent!.outcome).toBe('skipped');
    expect(ent!.reason).toBe('breaker_open');
    expect(ent!.cooldown_remaining_ms).toBe(42_000);
  });

  it('marks failing engine outcome=error', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.com/x')]),
      makeFailingEntry('ddg'),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ddg = out.data.engine_telemetry!.find((e) => e.name === 'ddg');
    expect(ddg).toBeDefined();
    expect(ddg!.outcome).toBe('error');
    expect(ddg!.result_count).toBe(0);
  });
});

// --- engine_warnings top-level surface ---
//
// WHY: integration test at the search-provider boundary. Module-level unit
// tests live in tests/unit/search/engine-warnings.test.ts; this asserts the
// wiring.

function makeHttpStatusFailingEntry(name: string, status: number): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async () => {
      throw new Error(`${name} returned ${status}`);
    }),
  };
  return { engine };
}

describe('engine_warnings (M2) — top-level search response surface', () => {
  it('emits empty engine_warnings when no engine errored', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.com/x')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Array.isArray(out.data.engine_warnings)).toBe(true);
    expect(out.data.engine_warnings).toEqual([]);
  });

  it('promotes a 400 engine failure into engine_warnings with http_400 code', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.com/x')]),
      makeHttpStatusFailingEntry('lobsters', 400),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const warn = out.data.engine_warnings!.find((w) => w.engine === 'lobsters');
    expect(warn).toBeDefined();
    expect(warn!.code).toBe('http_400');
    expect(warn!.hint).toBeUndefined();
  });

  it('promotes a github-code 401 with the WIGOLO_GITHUB_TOKEN env hint', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.com/x')]),
      makeHttpStatusFailingEntry('github-code', 401),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const warn = out.data.engine_warnings!.find((w) => w.engine === 'github-code');
    expect(warn).toBeDefined();
    expect(warn!.code).toBe('http_401');
    // env-var hint must mention the token name so users can act on it.
    expect(warn!.hint).toMatch(/WIGOLO_GITHUB_TOKEN/);
  });
});
