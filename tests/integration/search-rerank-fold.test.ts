import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../src/types.js';
import type { EngineEntry } from '../../src/search/core/engine-base.js';

const verticalState: {
  general: EngineEntry[]; news: EngineEntry[]; code: EngineEntry[]; docs: EngineEntry[]; papers: EngineEntry[];
} = { general: [], news: [], code: [], docs: [], papers: [] };

vi.mock('../../src/search/core/verticals/general.js', () => ({
  getGeneralEngines: () => verticalState.general,
  _resetGeneralEnginesForTest: () => { verticalState.general = []; },
}));
vi.mock('../../src/search/core/verticals/news.js', () => ({
  getNewsEngines: () => verticalState.news,
  _resetNewsEnginesForTest: () => { verticalState.news = []; },
}));
vi.mock('../../src/search/core/verticals/code.js', () => ({
  getCodeEngines: () => verticalState.code,
  _resetCodeEnginesForTest: () => { verticalState.code = []; },
}));
vi.mock('../../src/search/core/verticals/docs.js', () => ({
  getDocsEngines: () => verticalState.docs,
  _resetDocsEnginesForTest: () => { verticalState.docs = []; },
}));
vi.mock('../../src/search/core/verticals/papers.js', () => ({
  getPapersEngines: () => verticalState.papers,
  _resetPapersEnginesForTest: () => { verticalState.papers = []; },
}));

// Mock the rerank provider so tests never load the real ONNX model.
// rerankScores maps the result TITLE (first line of `${title}\n${snippet}`) -> logit.
const rerankScores: Record<string, number> = {};
vi.mock('../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: async () => ({
    modelId: 'test',
    rerank: async (_q: string, cands: { id: string; text: string }[]) =>
      cands.map((c) => ({ id: c.id, score: rerankScores[c.text.split('\n')[0]] ?? 0 })),
  }),
}));

// Config mock: force reranker to 'onnx' so the fold gate fires in a clean test
// environment regardless of WIGOLO_RERANKER env var. The reranker-none test
// overrides configReranker to 'none' for the duration of that single test.
let configReranker: 'onnx' | 'none' | 'custom' = 'onnx';
vi.mock('../../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config.js')>();
  return {
    ...real,
    getConfig: () => ({ ...real.getConfig(), reranker: configReranker }),
  };
});

const { CoreSearchProvider } = await import('../../src/search/core/core-provider.js');
const { _resetBreakersForTest } = await import('../../src/search/core/engine-base.js');

function makeResult(engineName: string, url: string, title: string, snippet: string): RawSearchResult {
  return { title, url, snippet, relevance_score: 1, engine: engineName };
}
function makeEntry(name: string, results: RawSearchResult[]): EngineEntry {
  const engine: SearchEngine = { name, search: vi.fn(async (_q: string, _o?: SearchEngineOptions) => results) };
  return { engine };
}
const ctx = { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never };

// engine returns OFFTOPIC first (higher composite via RRF arrival), ONTOPIC
// second. Both titles carry the shared query token ("uniqq") so they have
// non-zero lexical alignment — this test isolates the cross-encoder's semantic
// reorder, NOT the zero-lexical single-engine gate. The point is that OFFTOPIC
// wins the lexical/RRF composite yet the cross-encoder demotes it below the
// semantically-relevant ONTOPIC.
function seedEngines() {
  verticalState.general = [
    makeEntry('bing', [
      makeResult('bing', 'https://off.example.com', 'OFFTOPIC uniqq', 'unrelated filler uniqq'),
      makeResult('bing', 'https://on.example.com', 'ONTOPIC uniqq', 'the actual answer uniqq'),
    ]),
  ];
}

function emptyEntry(name: string): EngineEntry {
  const engine: SearchEngine = { name, search: vi.fn(async () => []) };
  return { engine };
}
// A probe-only engine held out of the primary wave. Returning empty here means
// the degraded-recovery wave fires (setting pool_degraded) without adding
// results — isolating the single junk survivor for the mechanism fixture.
function emptyProbe(name: string): EngineEntry {
  const engine: SearchEngine = { name, search: vi.fn(async () => []) };
  return { engine, quality: 'low', secondary: true, probeOnly: true };
}

beforeEach(() => {
  verticalState.general = []; verticalState.news = []; verticalState.code = [];
  verticalState.docs = []; verticalState.papers = [];
  for (const k of Object.keys(rerankScores)) delete rerankScores[k];
  configReranker = 'onnx';
  _resetBreakersForTest();
  vi.restoreAllMocks();
});

// D4 mechanism fixture (the live incident, deterministic): all-but-one engine
// absent, the lone survivor returns ONE zero-lexical result handed a high
// (gamed) rerank logit, flowing through the REAL rerank-fold + normalisation +
// score-floor at the core-provider seam. Each gate (a)-(d) is load-bearing:
//   (a) lexical gate forces the zero-lexical single-engine result to tier-0;
//   (b) blend guard neutralises the all-junk rerank stretch;
//   (d) normalisation guard refuses to stretch the weak degraded top to 1.0;
//   (c) floor withdraws the top-1 exemption from the zero-lexical survivor.
// Result: EMPTY results + pool_degraded.reasons contains 'no_lexical_match'.
describe('rerank-fold — D4 junk-floor mechanism fixture (degraded single-junk pool)', () => {
  it('a degraded pool whose only survivor is zero-lexical junk returns empty + no_lexical_match', async () => {
    // The survivor's result shares NO token with the English tech query (the
    // Japanese driving-school page from the incident). rerankScores hands it a
    // high logit — exactly the gamed-logit path that produced evidence ~1.0.
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://junk.example/jp', 'driving school reservation lessons', 'pricing and hours'),
      ]),
      emptyEntry('ddg'),
      emptyEntry('wikipedia'),
      emptyProbe('mojeek'),
    ];
    rerankScores['driving school reservation lessons'] = 9;

    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'kubernetes ingress controller setup', include_content: false },
      ctx,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The manufactured ~1.0 junk result must NOT be returned.
    expect(out.data.results).toHaveLength(0);
    // WHY is surfaced so the empty response is explainable.
    expect(out.data.engine_pool?.reasons).toContain('no_lexical_match');
    expect(out.data.engine_pool?.degraded).toBe(true);
  });

  it('MUST-NOT-FIRE: a degraded pool with a lexically-aligned survivor keeps it (no false empty)', async () => {
    // Same degraded shape but the survivor's result shares the query tokens.
    // The gates are inert on a lexical hit, so the result is kept and
    // no_lexical_match is NOT surfaced.
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://k8s.example/ingress', 'kubernetes ingress controller setup', 'configure kubernetes ingress controller'),
      ]),
      emptyEntry('ddg'),
      emptyEntry('wikipedia'),
      emptyProbe('mojeek'),
    ];
    rerankScores['kubernetes ingress controller setup'] = 6;

    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'kubernetes ingress controller setup', include_content: false },
      ctx,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results.map((r) => r.url)).toContain('https://k8s.example/ingress');
    expect(out.data.engine_pool?.reasons ?? []).not.toContain('no_lexical_match');
  });

  it('MUST-NOT-FIRE: a HEALTHY pool with a zero-lexical result does NOT empty', async () => {
    // Two healthy engines (not degraded). Even a zero-lexical result keeps the
    // top-1 exemption — the gates only fire on a degraded pool.
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://junk.example/jp', 'driving school reservation lessons', 'pricing and hours'),
      ]),
      makeEntry('ddg', [
        makeResult('ddg', 'https://other.example/y', 'unrelated topic page here', 'more filler'),
      ]),
    ];
    rerankScores['driving school reservation lessons'] = 3;
    rerankScores['unrelated topic page here'] = 2;

    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'kubernetes ingress controller setup', include_content: false },
      ctx,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Healthy pool -> not emptied; no_lexical_match not surfaced.
    expect(out.data.results.length).toBeGreaterThanOrEqual(1);
    expect(out.data.engine_pool?.reasons ?? []).not.toContain('no_lexical_match');
  });
});

describe('rerank-fold wiring', () => {
  it('balanced: cross-encoder demotes the content-irrelevant result below the relevant one', async () => {
    rerankScores['OFFTOPIC uniqq'] = -5;
    rerankScores['ONTOPIC uniqq'] = 5;
    seedEngines();
    const provider = new CoreSearchProvider();
    const out = await provider.search({ query: 'balanced rerank fold uniqq', include_content: false }, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results[0].url).toBe('https://on.example.com'); // fold flipped it to top
    expect(out.data.results[0].evidence_score?.components.cross_encoder).toBeDefined();
  });

  it('fast: fold not applied -> composite order kept, no cross_encoder component', async () => {
    rerankScores['OFFTOPIC uniqq'] = -5;
    rerankScores['ONTOPIC uniqq'] = 5;
    seedEngines();
    const provider = new CoreSearchProvider();
    const out = await provider.search({ query: 'fast tier no fold uniqq', search_depth: 'fast' }, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results[0].url).toBe('https://off.example.com'); // composite order preserved
    for (const r of out.data.results) {
      expect(r.evidence_score?.components.cross_encoder).toBeUndefined();
    }
  });

  it('reranker !== onnx: fold not applied even on balanced', async () => {
    configReranker = 'none';
    rerankScores['OFFTOPIC uniqq'] = -5;
    rerankScores['ONTOPIC uniqq'] = 5;
    seedEngines();
    const provider = new CoreSearchProvider();
    const out = await provider.search({ query: 'reranker none gate uniqq', include_content: false }, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results[0].url).toBe('https://off.example.com'); // fold skipped
    for (const r of out.data.results) {
      expect(r.evidence_score?.components.cross_encoder).toBeUndefined();
    }
  });
});
