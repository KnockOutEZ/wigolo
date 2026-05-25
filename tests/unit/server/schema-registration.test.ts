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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/cache/db.js', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getDatabase: vi.fn(() => null),
}));

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
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });
  afterEach(() => {
    resetConfig();
  });

  it('tools/list exposes 10 tools including diff and watch', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.listTools();
      const names = res.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        ['agent', 'cache', 'crawl', 'diff', 'extract', 'fetch', 'find_similar', 'research', 'search', 'watch']
      );
      expect(res.tools).toHaveLength(10);
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

  it('tools/call diff returns the not_implemented_yet notice tagged with slice B1', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({ name: 'diff', arguments: {} });
      const block = (res.content as Array<{ type: string; text: string }>)[0];
      const payload = JSON.parse(block.text);
      expect(payload).toMatchObject({ notice: 'not_implemented_yet', slice: 'B1' });
    } finally {
      await teardown();
    }
  });

  it('tools/call watch returns the not_implemented_yet notice tagged with slice B3', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({ name: 'watch', arguments: {} });
      const block = (res.content as Array<{ type: string; text: string }>)[0];
      const payload = JSON.parse(block.text);
      expect(payload).toMatchObject({ notice: 'not_implemented_yet', slice: 'B3' });
    } finally {
      await teardown();
    }
  });

  it('extract mode=brand returns the not_implemented_yet notice tagged with slice B2a', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({
        name: 'extract',
        arguments: { url: 'https://example.com/', mode: 'brand' },
      });
      const block = (res.content as Array<{ type: string; text: string }>)[0];
      const payload = JSON.parse(block.text);
      expect(payload).toMatchObject({ notice: 'not_implemented_yet', slice: 'B2a' });
    } finally {
      await teardown();
    }
  });
});
