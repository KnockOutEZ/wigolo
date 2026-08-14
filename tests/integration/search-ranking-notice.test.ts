import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, SearchEngineOptions, RawSearchResult, SearchInput } from '../../src/types.js';
import type { EngineEntry } from '../../src/search/core/engine-base.js';

// Tool-boundary proof for the ranking notice.
//
// WHY AT THIS SEAM: a unit test on the fold proves the signal is COMPUTED. It
// cannot prove the signal SURVIVES to the caller — a field can be dropped by
// response shaping or stripped by the content fence and the unit test stays
// green. This drives the same two calls server.ts makes for the `search` tool
// (handleSearch -> buildSearchContentBlocks) and parses the emitted MCP text
// block, which is literally the bytes a real MCP client receives.

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

// rerankScores maps the result TITLE -> raw score. The values below are REAL
// output captured from the shipped reranker for these query/result pairs.
const rerankScores: Record<string, number> = {};
vi.mock('../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: async () => ({
    modelId: 'test',
    rerank: async (_q: string, cands: { id: string; text: string }[]) =>
      cands.map((c) => ({ id: c.id, score: rerankScores[c.text.split('\n')[0]] ?? 0 })),
  }),
}));

vi.mock('../../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config.js')>();
  return {
    ...real,
    getConfig: () => ({ ...real.getConfig(), reranker: 'onnx' as const, searchBackend: 'core' }),
  };
});

const { handleSearch } = await import('../../src/tools/search.js');
const { buildSearchContentBlocks } = await import('../../src/server/search-response.js');
const { _resetBreakersForTest } = await import('../../src/search/core/engine-base.js');

function makeResult(engineName: string, url: string, title: string, snippet: string): RawSearchResult {
  return { title, url, snippet, relevance_score: 1, engine: engineName };
}
function makeEntry(name: string, results: RawSearchResult[]): EngineEntry {
  const engine: SearchEngine = { name, search: vi.fn(async (_q: string, _o?: SearchEngineOptions) => results) };
  return { engine };
}

// Two engines returning the SAME pages: multi-engine consensus, so the
// zero-lexical single-engine gate is not what is under test here. Every title
// carries the query token "home" so lexical alignment is non-zero too — the
// ONLY thing wrong with this pool is that the reranker rated all of it junk.
function seed(rows: [string, string, string][]) {
  const results = rows.map(([u, t, s]) => makeResult('bing', u, t, s));
  verticalState.general = [
    makeEntry('bing', results),
    makeEntry('ddg', results.map((r) => ({ ...r, engine: 'ddg' }))),
  ];
}

const JUNK: [string, string, string][] = [
  ['https://irrigation.telangana.gov.in/kaleshwaram', 'Kaleshwaram home irrigation project', 'Telangana lift irrigation scheme'],
  ['https://irrigation.telangana.gov.in/', 'Telangana irrigation home page', 'Department portal'],
  ['https://irrigation.telangana.gov.in/srsp', 'Sri Ram Sagar home project', 'Multipurpose irrigation project'],
];

const HEALTHY: [string, string, string][] = [
  ['https://www.home-assistant.io/', 'Home Assistant', 'Open source home automation'],
  ['https://www.home-assistant.io/installation/', 'Home Assistant Installation', 'Install Home Assistant OS'],
  ['https://www.home-assistant.io/docs/automation/', 'Home Assistant Automations', 'Create automations'],
];

const ctxArgs = [[], undefined as never, undefined, undefined, undefined] as const;

async function runSearch(input: SearchInput) {
  const r = await handleSearch(input, ...ctxArgs);
  if (!r.ok) throw new Error(`search failed: ${r.error_reason ?? r.error}`);
  return r;
}

/** Parse the JSON payload block exactly as an MCP client would. */
function parsePayload(input: SearchInput, data: Parameters<typeof buildSearchContentBlocks>[1]) {
  const blocks = buildSearchContentBlocks(input, data);
  const json = blocks.find((b) => {
    try { return typeof JSON.parse(b.text) === 'object'; } catch { return false; }
  });
  expect(json).toBeDefined();
  return JSON.parse(json!.text) as Record<string, unknown>;
}

beforeEach(() => {
  verticalState.general = []; verticalState.news = []; verticalState.code = [];
  verticalState.docs = []; verticalState.papers = [];
  for (const k of Object.keys(rerankScores)) delete rerankScores[k];
  _resetBreakersForTest();
  vi.restoreAllMocks();
});

describe('ranking notice reaches the search tool boundary', () => {
  it('an all-junk pool ships ranking_notice in the MCP payload a client receives', async () => {
    seed(JUNK);
    rerankScores['Kaleshwaram home irrigation project'] = -11.3377;
    rerankScores['Telangana irrigation home page'] = -11.3404;
    rerankScores['Sri Ram Sagar home project'] = -11.2956;

    const input: SearchInput = { query: 'home assistant', search_depth: 'balanced' };
    const r = await runSearch(input);

    // Present on the handler's own output...
    expect(r.data.ranking_notice).toBeTruthy();
    // ...and survives response shaping + the content fence into the MCP block.
    const payload = parsePayload(input, r.data);
    expect(typeof payload.ranking_notice).toBe('string');
    expect(payload.ranking_notice as string).toMatch(/relevance floor/i);
    expect(payload.ranking_notice as string).toMatch(/base cross-engine ranking/i);
    // Capability language only — no library, model or vendor name leaks out.
    expect(payload.ranking_notice as string).not.toMatch(
      /cross-encoder|transformers|onnx|minilm|ms-marco|xenova|logit/i,
    );
  });

  it('OVER-FIRE PROBE: a healthy pool ships no ranking_notice at all', async () => {
    seed(HEALTHY);
    rerankScores['Home Assistant'] = 7.3696;
    rerankScores['Home Assistant Installation'] = 5.8913;
    rerankScores['Home Assistant Automations'] = 7.0046;

    const input: SearchInput = { query: 'home assistant', search_depth: 'balanced' };
    const r = await runSearch(input);

    expect(r.data.ranking_notice).toBeUndefined();
    const payload = parsePayload(input, r.data);
    expect('ranking_notice' in payload).toBe(false);
    expect(r.data.results.length).toBeGreaterThan(0);
  });

  it('the notice is a DEDICATED field: `notice` is left alone for its own use', async () => {
    // Reusing `notice` would put the signal on a key that search-response.ts
    // overwrites with `warning` on the stream_answer path. Keeping them separate
    // is the whole reason this field exists.
    seed(JUNK);
    rerankScores['Kaleshwaram home irrigation project'] = -11.3377;
    rerankScores['Telangana irrigation home page'] = -11.3404;
    rerankScores['Sri Ram Sagar home project'] = -11.2956;

    const input: SearchInput = { query: 'home assistant', search_depth: 'balanced' };
    const r = await runSearch(input);

    expect(r.data.ranking_notice).toBeTruthy();
    expect(r.data.notice).toBeUndefined();
  });
});
