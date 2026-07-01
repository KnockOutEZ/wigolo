import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../src/types.js';
import type { EngineEntry } from '../../../src/search/core/engine-base.js';

// `engines_used` vs `engine_telemetry` semantics.
//
// WHY: the two arrays used to be indistinguishable to a caller — both
// contained "every engine that didn't error". The fix carves a clear divide:
//   - `engines_used`     = engines that contributed >= 1 result to the
//                          final fused/deduped list (semantic — "who
//                          ended up in the answer").
//   - `engine_telemetry` = every engine attempted (raw — "who fired").
//
// This test pins both ends so the doc and code agree.

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

function makeEmptyEntry(name: string): EngineEntry {
  // Engine returns 0 results, no error. Currently counted in `engines_used`;
  // after M1, must NOT be (no result survived dedup → didn't contribute).
  const engine: SearchEngine = {
    name,
    search: vi.fn(async () => []),
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

describe('engines_used vs engine_telemetry semantics', () => {
  it('engines_used contains only engines with >= 1 deduped result', async () => {
    // Two engines fire; one returns 0 results.
    // engine_telemetry must list BOTH (raw attempt log);
    // engines_used must list ONLY the engine that contributed (`bing`).
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.com/x')]),
      makeEmptyEntry('emptyEngine'),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Raw attempt log: every engine that fired.
    const telemetryNames = (out.data.engine_telemetry ?? []).map((t) => t.name).sort();
    expect(telemetryNames).toEqual(['bing', 'emptyEngine']);

    // Semantic surface: only contributors.
    expect(out.data.engines_used).toContain('bing');
    expect(out.data.engines_used).not.toContain('emptyEngine');
  });

  it('failing engine appears in engine_telemetry but not in engines_used', async () => {
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

    const telemetryNames = (out.data.engine_telemetry ?? []).map((t) => t.name).sort();
    expect(telemetryNames).toEqual(['bing', 'ddg']);

    expect(out.data.engines_used).toContain('bing');
    expect(out.data.engines_used).not.toContain('ddg');
  });

  it('engines_used reflects dedup_kept across the fused list, not raw result count', async () => {
    // Both engines return overlapping URLs. dedup_kept will be >0 for at
    // least one of them. The engine whose results all got de-duped out
    // SHOULD still appear in engines_used (its rank contributed via RRF
    // ties), but every engine in engines_used MUST have dedup_kept > 0
    // in its telemetry row.
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.com/x')]),
      makeEntry('ddg', [makeResult('ddg', 'https://a.com/x')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const telemetry = out.data.engine_telemetry ?? [];
    for (const name of out.data.engines_used) {
      const row = telemetry.find((t) => t.name === name);
      expect(row).toBeDefined();
      expect(row!.dedup_kept).toBeGreaterThan(0);
    }
  });
});
