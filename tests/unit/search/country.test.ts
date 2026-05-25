import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawSearchResult, SearchEngineOptions } from '../../../src/types.js';
import type { EngineEntry } from '../../../src/search/core/engine-base.js';
import { BingEngine } from '../../../src/search/engines/bing.js';
import { DuckDuckGoEngine } from '../../../src/search/engines/duckduckgo.js';

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

const { runV1Search } = await import('../../../src/search/core/orchestrator.js');

function makeResult(engineName: string, url: string): RawSearchResult {
  return { title: 'T', url, snippet: 'S', relevance_score: 1, engine: engineName };
}

beforeEach(() => {
  verticalState.general = [];
  verticalState.news = [];
  verticalState.code = [];
  verticalState.docs = [];
  verticalState.papers = [];
});

describe('country option (sub-ticket 3.5)', () => {
  it('orchestrator forwards country to engines via SearchEngineOptions', async () => {
    let captured: SearchEngineOptions | undefined;
    const engine = {
      name: 'bing',
      search: vi.fn(async (_q: string, opts?: SearchEngineOptions) => {
        captured = opts;
        return [makeResult('bing', 'https://example.com/a')];
      }),
    };
    verticalState.general = [{ engine }];

    await runV1Search({ query: 'q', country: 'us' });

    expect(captured?.country).toBe('us');
  });

  it('Bing engine includes cc=<country> in URL when option set', async () => {
    let calledUrl = '';
    const fetchMock = vi.fn(async (input: string) => {
      calledUrl = input;
      return {
        ok: true,
        text: async () => '<html><body></body></html>',
      } as Response;
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const e = new BingEngine();
      await e.search('q', { country: 'us', timeoutMs: 1000 });
    } finally {
      globalThis.fetch = orig;
    }
    expect(calledUrl).toContain('cc=us');
  });

  it('DuckDuckGo engine includes kl=<country>-<lang> in body params when option set', async () => {
    let calledUrl = '';
    const fetchMock = vi.fn(async (input: string) => {
      calledUrl = input;
      return {
        ok: true,
        text: async () => '<html><body></body></html>',
      } as Response;
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const e = new DuckDuckGoEngine();
      await e.search('q', { country: 'gb', language: 'en', timeoutMs: 1000 });
    } finally {
      globalThis.fetch = orig;
    }
    expect(calledUrl).toContain('kl=gb-en');
  });

  it('omits cc when country not set on Bing', async () => {
    let calledUrl = '';
    const fetchMock = vi.fn(async (input: string) => {
      calledUrl = input;
      return { ok: true, text: async () => '' } as Response;
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const e = new BingEngine();
      await e.search('q', { timeoutMs: 1000 });
    } finally {
      globalThis.fetch = orig;
    }
    expect(calledUrl).not.toContain('cc=');
  });
});
