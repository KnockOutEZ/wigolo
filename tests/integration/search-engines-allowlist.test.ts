// search_engines allowlist at the MCP / one-shot CLI tool boundary
// (WIGOLO_SEARCH=core). The orchestrator unit suite covers dispatch mechanics;
// this file pins that handleSearch actually consumes the advertised parameter
// rather than the leftover engines[] argument (the bing+duckduckgo seed
// createKeylessDirectEngines still hands CLI / MCP), and that the CLI header
// (`engines: …`) and MCP tools/call JSON agree.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import type { EngineEntry } from '../../src/search/core/engine-base.js';

const verticalState: {
  general: EngineEntry[];
  news: EngineEntry[];
  code: EngineEntry[];
  docs: EngineEntry[];
  papers: EngineEntry[];
  images: EngineEntry[];
} = { general: [], news: [], code: [], docs: [], papers: [], images: [] };

/** Production leftover seed (`createKeylessDirectEngines`) — distinct spies
 * from the vertical catalog so a leak through `ctx.engines` is visible. */
const leftoverState: { engines: SearchEngine[] } = { engines: [] };

vi.mock('../../src/search/core/verticals/general.js', () => ({
  getGeneralEngines: () => verticalState.general,
  _resetGeneralEnginesForTest: () => {
    verticalState.general = [];
  },
}));
vi.mock('../../src/search/core/verticals/news.js', () => ({
  getNewsEngines: () => verticalState.news,
  _resetNewsEnginesForTest: () => {
    verticalState.news = [];
  },
}));
vi.mock('../../src/search/core/verticals/code.js', () => ({
  getCodeEngines: () => verticalState.code,
  _resetCodeEnginesForTest: () => {
    verticalState.code = [];
  },
}));
vi.mock('../../src/search/core/verticals/docs.js', () => ({
  getDocsEngines: () => verticalState.docs,
  _resetDocsEnginesForTest: () => {
    verticalState.docs = [];
  },
}));
vi.mock('../../src/search/core/verticals/papers.js', () => ({
  getPapersEngines: () => verticalState.papers,
  _resetPapersEnginesForTest: () => {
    verticalState.papers = [];
  },
}));
vi.mock('../../src/search/core/verticals/images.js', () => ({
  getImageEngines: () => verticalState.images,
  _resetImageEnginesForTest: () => {
    verticalState.images = [];
  },
}));

vi.mock('../../src/cache/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cache/store.js')>();
  return {
    ...actual,
    getCachedSearchResults: vi.fn(() => null),
    cacheSearchResults: vi.fn(),
  };
});

vi.mock('../../src/search/direct-engines.js', () => ({
  createKeylessDirectEngines: () => leftoverState.engines,
}));

vi.mock('../../src/cache/db.js', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../../src/fetch/browser-pool.js', () => {
  class MockPool {
    shutdown = vi.fn(async () => {});
    fetchWithBrowser = vi.fn();
    getConfiguredTypes = vi.fn().mockReturnValue(['chromium']);
    getStats = vi.fn().mockReturnValue([]);
    acquire = vi.fn();
    release = vi.fn();
  }
  return {
    MultiBrowserPool: MockPool,
    BrowserPool: class extends MockPool {},
  };
});

vi.mock('../../src/fetch/http-client.js', () => ({
  httpFetch: vi.fn(),
}));

vi.mock('../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({
    init: vi.fn().mockResolvedValue(undefined),
    isAvailable: () => false,
    shutdown: vi.fn(),
  }),
  resetEmbeddingService: vi.fn(),
}));

vi.mock('../../src/searxng/bootstrap.js', () => ({
  resolveSearchBackend: vi.fn().mockResolvedValue({ type: 'scraping' }),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/searxng/process.js', () => ({
  SearxngProcess: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
    getUrl: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../../src/searxng/docker.js', () => ({
  DockerSearxng: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/plugins/loader.js', () => ({
  loadPlugins: vi.fn(async () => ({
    extractors: [],
    searchEngines: [],
    loaded: [],
    errors: [],
  })),
}));

import { handleSearch } from '../../src/tools/search.js';
import { _resetSearchProviderForTest } from '../../src/providers/search-provider.js';
import { resetConfig } from '../../src/config.js';
import { runTool } from '../../src/cli/tool-run.js';
import { stripAnsi } from '../../src/repl/formatters.js';

function makeResult(engineName: string, url: string): RawSearchResult {
  return { title: engineName, url, snippet: 'S', relevance_score: 1, engine: engineName };
}

function makeEntry(name: string, results: RawSearchResult[]): {
  entry: EngineEntry;
  engine: SearchEngine;
  search: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async (_q: string, _opts?: SearchEngineOptions) => results);
  const engine: SearchEngine = { name, search };
  return { entry: { engine }, engine, search };
}

function seedGeneralPool(): {
  leftoverBing: ReturnType<typeof makeEntry>;
  leftoverDdg: ReturnType<typeof makeEntry>;
  bing: ReturnType<typeof makeEntry>;
  ddg: ReturnType<typeof makeEntry>;
  wiki: ReturnType<typeof makeEntry>;
} {
  const leftoverBing = makeEntry('bing', [makeResult('bing', 'https://leftover-bing.test/1')]);
  const leftoverDdg = makeEntry('duckduckgo', [makeResult('duckduckgo', 'https://leftover-ddg.test/1')]);
  leftoverState.engines = [leftoverBing.engine, leftoverDdg.engine];

  const bing = makeEntry('bing', [makeResult('bing', 'https://bing.test/1')]);
  const ddg = makeEntry('duckduckgo', [makeResult('duckduckgo', 'https://ddg.test/1')]);
  const wiki = makeEntry('wikipedia', [makeResult('wikipedia', 'https://en.wikipedia.org/wiki/Gold')]);
  verticalState.general = [bing.entry, ddg.entry, wiki.entry];
  return { leftoverBing, leftoverDdg, bing, ddg, wiki };
}

function captureStdout(): { restore: () => void; text: () => string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const stub = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
  });
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => { process.stdout.write = original; stub.destroy(); },
    text: () => chunks.join(''),
  };
}

function parseMcpJson(content: unknown): Record<string, unknown> {
  const blocks = content as Array<{ type: string; text: string }>;
  const jsonBlock = [...blocks].reverse().find((b) => {
    try {
      JSON.parse(b.text);
      return true;
    } catch {
      return false;
    }
  });
  if (!jsonBlock) throw new Error('MCP search returned no JSON content block');
  return JSON.parse(jsonBlock.text) as Record<string, unknown>;
}

async function connectMcpClient(): Promise<{
  client: Client;
  teardown: () => Promise<void>;
}> {
  const { initSubsystems, createMcpServer } = await import('../../src/server.js');
  const subs = await initSubsystems();
  const server = createMcpServer(subs);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'allowlist-test', version: '1.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    teardown: async () => {
      await client.close();
      await server.close();
      await subs.shutdown();
    },
  };
}

const fakeRouter = {} as SmartRouter;

describe('search_engines allowlist (core tool boundary)', () => {
  const origEnv = process.env;
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'wigolo-allowlist-'));
    process.env = {
      ...origEnv,
      WIGOLO_SEARCH: 'core',
      WIGOLO_RERANKER: 'none',
      VALIDATE_LINKS: 'false',
      LOG_LEVEL: 'error',
      WIGOLO_DATA_DIR: tmpDataDir,
      WIGOLO_WARM_ENGINES: '0',
      WIGOLO_PLUGINS_DIR: join(tmpDataDir, 'no-plugins'),
    };
    resetConfig();
    _resetSearchProviderForTest();
    leftoverState.engines = [];
    verticalState.general = [];
    verticalState.news = [];
    verticalState.code = [];
    verticalState.docs = [];
    verticalState.papers = [];
    verticalState.images = [];
  });

  afterEach(() => {
    process.env = origEnv;
    resetConfig();
    _resetSearchProviderForTest();
    leftoverState.engines = [];
    try { rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('dispatches only the named engines, even when Bing is in the leftover seed and the default pool', async () => {
    const { leftoverBing, leftoverDdg, bing, ddg, wiki } = seedGeneralPool();

    const r = await handleSearch(
      {
        query: 'gold price',
        search_engines: ['duckduckgo', 'wikipedia'],
        include_content: false,
      },
      leftoverState.engines,
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(leftoverBing.search).not.toHaveBeenCalled();
    expect(leftoverDdg.search).not.toHaveBeenCalled();
    expect(bing.search).not.toHaveBeenCalled();
    expect(ddg.search).toHaveBeenCalledOnce();
    expect(wiki.search).toHaveBeenCalledOnce();
    expect(r.data.engines_used.sort()).toEqual(['duckduckgo', 'wikipedia']);
  });

  it('pulls a requested engine from another vertical', async () => {
    const bing = makeEntry('bing', [makeResult('bing', 'https://bing.test/1')]);
    verticalState.general = [bing.entry];
    const so = makeEntry('stackoverflow', [makeResult('stackoverflow', 'https://stackoverflow.com/q/1')]);
    verticalState.code = [so.entry];

    const r = await handleSearch(
      {
        query: 'gold price',
        search_engines: ['stackoverflow'],
        include_content: false,
      },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(bing.search).not.toHaveBeenCalled();
    expect(so.search).toHaveBeenCalledOnce();
    expect(r.data.engines_used).toEqual(['stackoverflow']);
  });

  it('falls back to the default pool when no requested name matches', async () => {
    const bing = makeEntry('bing', [makeResult('bing', 'https://bing.test/1')]);
    verticalState.general = [bing.entry];

    const r = await handleSearch(
      {
        query: 'gold price',
        search_engines: ['not-a-real-engine'],
        include_content: false,
      },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(bing.search).toHaveBeenCalledOnce();
    expect(r.data.engines_used).toEqual(['bing']);
    const warn = r.data.engine_warnings?.find((w) => w.engine === 'not-a-real-engine');
    expect(warn).toMatchObject({
      engine: 'not-a-real-engine',
      code: 'unknown_engine',
    });
    expect(warn?.hint).toMatch(/available:/);
    expect(warn?.message).toMatch(/default pool/);
  });

  it('surfaces unknown names in engine_warnings when some engines still match', async () => {
    const ddg = makeEntry('duckduckgo', [makeResult('duckduckgo', 'https://ddg.test/1')]);
    verticalState.general = [ddg.entry];

    const r = await handleSearch(
      {
        query: 'gold price',
        search_engines: ['duckduckgo', 'google'],
        include_content: false,
      },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(ddg.search).toHaveBeenCalledOnce();
    expect(r.data.engines_used).toEqual(['duckduckgo']);
    const warn = r.data.engine_warnings?.find((w) => w.engine === 'google');
    expect(warn).toMatchObject({
      engine: 'google',
      code: 'unknown_engine',
    });
    expect(warn?.message).toMatch(/ignored/);
    expect(warn?.hint).toMatch(/duckduckgo/);
  });

  it('CLI: wigolo search --search-engines=duckduckgo,wikipedia does not print engines: bing', async () => {
    const { leftoverBing, leftoverDdg, bing, ddg, wiki } = seedGeneralPool();
    const cap = captureStdout();
    let code: number;
    try {
      code = await runTool('search', [
        'gold price',
        '--search-engines=duckduckgo,wikipedia',
        '--no-content',
      ]);
    } finally {
      cap.restore();
    }

    expect(code).toBe(0);
    expect(leftoverBing.search).not.toHaveBeenCalled();
    expect(leftoverDdg.search).not.toHaveBeenCalled();
    expect(bing.search).not.toHaveBeenCalled();
    expect(ddg.search).toHaveBeenCalledOnce();
    expect(wiki.search).toHaveBeenCalledOnce();

    const header = stripAnsi(cap.text()).split('\n')[0] ?? '';
    expect(header).toContain('engines:');
    expect(header).not.toMatch(/\bbing\b/);
    expect(header).toMatch(/\bduckduckgo\b/);
    expect(header).toMatch(/\bwikipedia\b/);
  });

  it('MCP: search_engines: ["duckduckgo"] does not dispatch bing', async () => {
    const { leftoverBing, leftoverDdg, bing, ddg, wiki } = seedGeneralPool();
    const { client, teardown } = await connectMcpClient();
    try {
      const res = await client.callTool({
        name: 'search',
        arguments: {
          query: 'gold price',
          search_engines: ['duckduckgo'],
          include_content: false,
        },
      });
      expect(res.isError).toBeFalsy();
      const payload = parseMcpJson(res.content);
      expect(payload.engines_used).toEqual(['duckduckgo']);
      expect(payload.engines_used).not.toContain('bing');

      expect(leftoverBing.search).not.toHaveBeenCalled();
      expect(leftoverDdg.search).not.toHaveBeenCalled();
      expect(bing.search).not.toHaveBeenCalled();
      expect(wiki.search).not.toHaveBeenCalled();
      expect(ddg.search).toHaveBeenCalledOnce();
    } finally {
      await teardown();
    }
  });
});
