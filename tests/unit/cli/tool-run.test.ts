import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { SearchOutput, FetchOutput, StageResult } from '../../../src/types.js';

// The runner must NEVER touch the searxng bootstrap. Mock the bootstrap module
// with throwing spies so any accidental call fails the test loudly.
const resolveSearchBackend = vi.fn(() => { throw new Error('resolveSearchBackend must not be called'); });
const getBootstrapState = vi.fn(() => { throw new Error('getBootstrapState must not be called'); });
vi.mock('../../../src/searxng/bootstrap.js', () => ({
  resolveSearchBackend,
  getBootstrapState,
}));
const searxngStart = vi.fn();
vi.mock('../../../src/searxng/process.js', () => ({
  SearxngProcess: class {
    start = searxngStart;
    stop = vi.fn();
    getUrl = vi.fn();
  },
}));

// Keep the DB + browser pool inert.
vi.mock('../../../src/cache/db.js', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));
vi.mock('../../../src/fetch/browser-pool.js', () => ({
  BrowserPool: class {
    shutdown = vi.fn(async () => {});
  },
}));
vi.mock('../../../src/cli/shutdown.js', () => ({
  shutdownCli: vi.fn(async () => {}),
}));

// Domain handlers.
vi.mock('../../../src/tools/search.js', () => ({ handleSearch: vi.fn() }));
vi.mock('../../../src/tools/fetch.js', () => ({ handleFetch: vi.fn() }));
vi.mock('../../../src/tools/research.js', () => ({ handleResearch: vi.fn() }));

import { handleSearch } from '../../../src/tools/search.js';
import { handleFetch } from '../../../src/tools/fetch.js';
import { handleResearch } from '../../../src/tools/research.js';
import { runTool } from '../../../src/cli/tool-run.js';

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

const okSearch: StageResult<SearchOutput> = {
  ok: true,
  data: { results: [{ title: 't', url: 'https://x.com', snippet: 's', relevance_score: 0.9, source: 'core' } as SearchOutput['results'][number]], query: 'q', engines_used: ['core'], total_time_ms: 1 },
};

describe('runTool', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it('never calls resolveSearchBackend / getBootstrapState / SearxngProcess.start', async () => {
    vi.mocked(handleSearch).mockResolvedValue(okSearch);
    const cap = captureStdout();
    try {
      await runTool('search', ['react hooks', '--json']);
    } finally {
      cap.restore();
    }
    expect(resolveSearchBackend).not.toHaveBeenCalled();
    expect(getBootstrapState).not.toHaveBeenCalled();
    expect(searxngStart).not.toHaveBeenCalled();
  });

  it('WHY: seeds direct web engines so one-shot research/agent/find_similar find sources (not searxng-empty)', async () => {
    // research/agent/find_similar pipelines search the passed SearchEngine
    // instances directly (unlike search/fetch, which use the core provider).
    // A one-shot run with an empty engines list silently returns zero sources —
    // this guards that the runner seeds the keyless direct engines.
    vi.mocked(handleResearch).mockResolvedValue({
      report: 'r', sources: [], sub_queries: [], citations: [],
    } as unknown as Awaited<ReturnType<typeof handleResearch>>);
    const cap = captureStdout();
    try {
      await runTool('research', ['what is rag', '--json']);
    } finally {
      cap.restore();
    }
    expect(handleResearch).toHaveBeenCalled();
    const enginesArg = vi.mocked(handleResearch).mock.calls[0][1];
    expect(Array.isArray(enginesArg)).toBe(true);
    expect(enginesArg.length).toBeGreaterThanOrEqual(2);
  });

  it('search --json: exit 0 and full stdout parses as the MCP-shape data', async () => {
    vi.mocked(handleSearch).mockResolvedValue(okSearch);
    const cap = captureStdout();
    let code: number;
    try {
      code = await runTool('search', ['react hooks', '--json']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.text());
    expect(parsed.results).toBeDefined();
    expect(parsed.results[0].url).toBe('https://x.com');
  });

  it('WHY: one-shot --json deep-equals the MCP tool result for the same input', async () => {
    vi.mocked(handleSearch).mockResolvedValue(okSearch);

    // MCP dispatch shape: JSON.stringify(r.data) on success (server.ts).
    const mcpText = JSON.stringify(okSearch.ok ? okSearch.data : {}, null, 2);
    const mcpParsed = JSON.parse(mcpText);

    const cap = captureStdout();
    try {
      await runTool('search', ['react hooks', '--json']);
    } finally {
      cap.restore();
    }
    const cliParsed = JSON.parse(cap.text());
    expect(cliParsed).toEqual(mcpParsed);
  });

  it('fetch --json: exit 0 and .content-equivalent field parses', async () => {
    const okFetch: StageResult<FetchOutput> = {
      ok: true,
      data: { url: 'https://x.com', title: 'T', markdown: '# hi', metadata: {}, links: [], images: [], cached: false },
    };
    vi.mocked(handleFetch).mockResolvedValue(okFetch);
    const cap = captureStdout();
    let code: number;
    try {
      code = await runTool('fetch', ['https://x.com', '--json']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.text());
    expect(parsed.markdown).toBe('# hi');
  });

  it('a failing --json invocation exits 1 with a parseable JSON error object on stdout', async () => {
    vi.mocked(handleFetch).mockResolvedValue({
      ok: false, error: 'fetch_failed', error_reason: 'boom', stage: 'fetch',
    });
    const cap = captureStdout();
    let code: number;
    try {
      code = await runTool('fetch', ['https://x.com', '--json']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.text());
    expect(parsed.error).toBeDefined();
    expect(JSON.stringify(parsed)).toContain('boom');
  });

  it('a thrown handler under --json exits 1 with a JSON error object', async () => {
    vi.mocked(handleSearch).mockRejectedValue(new Error('kaboom'));
    const cap = captureStdout();
    let code: number;
    try {
      code = await runTool('search', ['q', '--json']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.text());
    expect(parsed.error).toBeDefined();
  });

  it('--help exits 0 and writes usage', async () => {
    const cap = captureStdout();
    let code: number;
    try {
      code = await runTool('search', ['--help']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.text().toLowerCase()).toContain('search');
    expect(handleSearch).not.toHaveBeenCalled();
  });

  it('non-json failing invocation still exits 1', async () => {
    vi.mocked(handleFetch).mockResolvedValue({
      ok: false, error: 'fetch_failed', error_reason: 'nope', stage: 'fetch',
    });
    const cap = captureStdout();
    let code: number;
    try {
      code = await runTool('fetch', ['https://x.com']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
  });
});
