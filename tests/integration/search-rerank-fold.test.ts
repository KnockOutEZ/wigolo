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

function makeResult(engineName: string, url: string, title: string, snippet: string): RawSearchResult {
  return { title, url, snippet, relevance_score: 1, engine: engineName };
}
function makeEntry(name: string, results: RawSearchResult[]): EngineEntry {
  const engine: SearchEngine = { name, search: vi.fn(async (_q: string, _o?: SearchEngineOptions) => results) };
  return { engine };
}
const ctx = { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never };

// engine returns OFFTOPIC first (higher composite via RRF arrival), ONTOPIC second.
function seedEngines() {
  verticalState.general = [
    makeEntry('bing', [
      makeResult('bing', 'https://off.example.com', 'OFFTOPIC', 'unrelated filler'),
      makeResult('bing', 'https://on.example.com', 'ONTOPIC', 'the actual answer'),
    ]),
  ];
}

beforeEach(() => {
  verticalState.general = []; verticalState.news = []; verticalState.code = [];
  verticalState.docs = []; verticalState.papers = [];
  for (const k of Object.keys(rerankScores)) delete rerankScores[k];
  configReranker = 'onnx';
  vi.restoreAllMocks();
});

describe('rerank-fold wiring', () => {
  it('balanced: cross-encoder demotes the content-irrelevant result below the relevant one', async () => {
    rerankScores['OFFTOPIC'] = -5;
    rerankScores['ONTOPIC'] = 5;
    seedEngines();
    const provider = new CoreSearchProvider();
    const out = await provider.search({ query: 'balanced rerank fold uniqq', include_content: false }, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results[0].url).toBe('https://on.example.com'); // fold flipped it to top
    expect(out.data.results[0].evidence_score?.components.cross_encoder).toBeDefined();
  });

  it('fast: fold not applied -> composite order kept, no cross_encoder component', async () => {
    rerankScores['OFFTOPIC'] = -5;
    rerankScores['ONTOPIC'] = 5;
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
    rerankScores['OFFTOPIC'] = -5;
    rerankScores['ONTOPIC'] = 5;
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
