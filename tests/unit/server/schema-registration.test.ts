/**
 * Slice A1: schema groundwork for `diff` + `watch` + brand mode.
 *
 * Why this matters:
 *  - The MCP `tools/list` surface is part of the wigolo contract — adding
 *    `diff` and `watch` increases it from 8 to 10 tools. A test that asserts
 *    on exact tool count + names protects future PRs (especially A1's stub
 *    handlers) from accidentally dropping either tool when the dispatch
 *    chain in `server.ts` is edited.
 *  - The stub handlers must return a structured `not_implemented_yet`
 *    notice so dependent slices (B1, B2a, B3) can tell whether they were
 *    correctly wired before they ship the real implementation. A silent
 *    "Unknown tool" branch would mask a registration regression.
 *  - `extract({ mode: 'brand' })` must accept the new mode without
 *    rejecting via the existing JSON-schema enum guard, and must dispatch
 *    to the stub rather than silently falling through to metadata.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetConfig } from '../../../src/config.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';

// Slice B3 made the `watch` handler hit the real DB (via the cache/db.js
// `getDatabase()` helper), so the schema-registration suite needs a real
// in-memory SQLite. We can't keep the old `getDatabase: () => null` mock
// or the migration runner has nowhere to apply the 004-watch-jobs table.
//
// Strategy: stub `cache/db.js` to bind every initDatabase call onto a
// shared `:memory:` instance for the duration of the test file. The real
// migration runner attaches to it and the watch tool reads/writes
// normally. Other test files keep their own mocks.
vi.mock('../../../src/cache/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cache/db.js')>(
    '../../../src/cache/db.js',
  );
  return {
    ...actual,
    initDatabase: (_path?: string) => actual.initDatabase(':memory:'),
  };
});

vi.mock('../../../src/fetch/browser-pool.js', () => {
  class MockMultiBrowserPool {
    shutdown = vi.fn().mockResolvedValue(undefined);
    fetchWithBrowser = vi.fn();
    getConfiguredTypes = vi.fn().mockReturnValue(['chromium']);
    getStats = vi.fn().mockReturnValue([]);
  }
  return {
    MultiBrowserPool: MockMultiBrowserPool,
    BrowserPool: class MockBrowserPool extends MockMultiBrowserPool {
      acquire = vi.fn();
      release = vi.fn();
    },
  };
});

vi.mock('../../../src/fetch/http-client.js', () => ({
  httpFetch: vi.fn(),
}));

vi.mock('../../../src/fetch/router.js', () => {
  return {
    SmartRouter: class MockSmartRouter {
      constructor(_httpClient: unknown, _browserPool: unknown) {}
      fetch = vi.fn().mockResolvedValue({
        url: 'https://example.com/',
        finalUrl: 'https://example.com/',
        html: '<html><head><title>x</title></head><body></body></html>',
        contentType: 'text/html',
        statusCode: 200,
        method: 'http',
        headers: {},
      });
      getDomainStats = vi.fn();
    },
  };
});

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  resolveSearchBackend: vi.fn().mockResolvedValue({ type: 'scraping' }),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/searxng/process.js', () => ({
  SearxngProcess: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
    getUrl: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../../../src/searxng/docker.js', () => ({
  DockerSearxng: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn().mockReturnValue(null),
  isExpired: vi.fn().mockReturnValue(false),
}));

// Avoid cold ONNX startup on every `connectClient()` — schema registration
// + stub dispatch never need the real embedding subprocess.
vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({
    init: vi.fn().mockResolvedValue(undefined),
    isAvailable: () => false,
    shutdown: vi.fn(),
  }),
  resetEmbeddingService: vi.fn(),
}));

async function connectClient() {
  const { initSubsystems, createMcpServer } = await import('../../../src/server.js');
  const subs = await initSubsystems();
  const server = createMcpServer(subs);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const teardown = async () => {
    await client.close();
    await server.close();
    await subs.shutdown();
  };

  return { client, teardown };
}

describe('Slice A1 — diff + watch tool registration', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'wigolo-schema-reg-'));
    process.env.WIGOLO_DATA_DIR = tmpDataDir;
    resetConfig();
    _resetMigrationGuard();
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.WIGOLO_DATA_DIR;
    resetConfig();
    try { rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('tools/list exposes 14 tools including diff, watch, and the four studio tools', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.listTools();
      const names = res.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        ['agent', 'cache', 'crawl', 'diff', 'extract', 'fetch', 'find_similar', 'research', 'search', 'studio_act', 'studio_capture', 'studio_marks', 'studio_observe', 'watch']
      );
      expect(res.tools).toHaveLength(14);
    } finally {
      await teardown();
    }
  });

  it('tools/list entries for diff + watch carry an input schema with type:object', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.listTools();
      const diff = res.tools.find((t) => t.name === 'diff');
      const watch = res.tools.find((t) => t.name === 'watch');
      expect(diff?.inputSchema?.type).toBe('object');
      expect(watch?.inputSchema?.type).toBe('object');
    } finally {
      await teardown();
    }
  });

  // Slice B1 (2026-05-26): diff is no longer a stub. The MCP surface must
  // accept the real input shape ({ old, new, output }) and return a
  // structured DiffOutput rather than the `not_implemented_yet` notice.
  it('tools/call diff computes a real diff between two markdown bodies', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({
        name: 'diff',
        arguments: {
          old: { markdown: 'one\ntwo\nthree\n' },
          new: { markdown: 'one\nTWO\nthree\n' },
          output: 'unified',
        },
      });
      const block = (res.content as Array<{ type: string; text: string }>)[0];
      const payload = JSON.parse(block.text);
      expect(payload.changed).toBe(true);
      expect(payload.unified_diff).toContain('-two');
      expect(payload.unified_diff).toContain('+TWO');
      expect(payload.notice).toBeUndefined();
    } finally {
      await teardown();
    }
  });

  it('tools/call watch with no action returns a real error envelope (B3 shipped — no stub)', async () => {
    // Slice B3 replaced the stub with the real handler, so an empty
    // payload now yields a typed input-error envelope instead of the
    // `not_implemented_yet` notice. The error path still proves the tool
    // is wired into the dispatch chain.
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({ name: 'watch', arguments: {} });
      const block = (res.content as Array<{ type: string; text: string }>)[0];
      const payload = JSON.parse(block.text);
      expect(payload.error).toBe('invalid_input');
      expect(payload.stage).toBe('watch');
      expect(payload.error_reason).toMatch(/action/);
    } finally {
      await teardown();
    }
  });

  it('tools/call watch with action=list returns a jobs array (B3 shipped)', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({ name: 'watch', arguments: { action: 'list' } });
      const block = (res.content as Array<{ type: string; text: string }>)[0];
      const payload = JSON.parse(block.text);
      expect(Array.isArray(payload.jobs)).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('extract mode=brand routes through the real B2a extractor and returns a BrandExtractionOutput envelope', async () => {
    // After B2a landed, brand mode no longer returns the
    // `not_implemented_yet` stub envelope; it dispatches to
    // `src/extraction/brand.ts` and returns a structured payload with
    // `provenance` always present. The mocked router serves a minimal page
    // so we just assert the envelope shape, not specific brand fields.
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({
        name: 'extract',
        arguments: { url: 'https://example.com/', mode: 'brand' },
      });
      const block = (res.content as Array<{ type: string; text: string }>)[0];
      const payload = JSON.parse(block.text);
      expect(payload.mode).toBe('brand');
      expect(payload).not.toHaveProperty('notice');
      expect(payload).not.toHaveProperty('slice');
      expect(payload.data).toBeDefined();
      // Provenance is always emitted by the brand extractor — its absence
      // would mean we accidentally fell back to the stub or the metadata
      // path.
      expect((payload.data as Record<string, unknown>).provenance).toBeDefined();
    } finally {
      await teardown();
    }
  });
});
