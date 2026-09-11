/**
 * MCP capability-hint coverage for `tools/list`.
 *
 * Hosts decide whether a tool call needs a permission prompt from these
 * annotations, so a tool that ships without them prompts on every call. The
 * exact matrix is pinned here: adding an eleventh tool without annotating it
 * fails this suite rather than silently regressing the permission story in
 * every host wigolo installs into.
 *
 * The two non-read-only rows are the point of the test. `cache` accepts
 * `clear` and `watch` accepts `create`/`delete`, so claiming either is
 * read-only would be a lie a host would act on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetConfig } from '../../../src/config.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';

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

vi.mock('../../../src/fetch/router.js', () => ({
  SmartRouter: class MockSmartRouter {
    constructor(_httpClient: unknown, _browserPool: unknown) {}
    fetch = vi.fn();
    getDomainStats = vi.fn();
  },
}));

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

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({
    init: vi.fn().mockResolvedValue(undefined),
    isAvailable: () => false,
    shutdown: vi.fn(),
  }),
  resetEmbeddingService: vi.fn(),
}));

const HINT_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

type HintMatrix = Record<(typeof HINT_KEYS)[number], boolean>;

// Three tools are not read-only, and none of them look it from the name alone:
//   `fetch`  — `actions` runs live click/type via Playwright
//   `cache`  — `clear` deletes rows
//   `watch`  — create/delete mutate the job store
// `diff` is the only closed-world tool: it resolves its `url` sides from the
// local cache and returns `cache_miss` rather than fetching (src/tools/diff.ts).
// `cache` looks local but `check_changes` re-fetches over the network
// (src/tools/cache.ts).
const EXPECTED: Record<string, HintMatrix> = {
  fetch: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  crawl: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cache: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  extract: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  find_similar: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  research: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  agent: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  diff: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  watch: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

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

describe('tools/list capability annotations', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'wigolo-tool-annotations-'));
    process.env.WIGOLO_DATA_DIR = tmpDataDir;
    // `pluginsDir` defaults to `<dataDir>/plugins`, so the line above already
    // isolates it — but pin it anyway so an exported WIGOLO_PLUGINS_DIR in the
    // developer's shell can't make `initSubsystems()` import real plugin code.
    process.env.WIGOLO_PLUGINS_DIR = join(tmpDataDir, 'plugins');
    resetConfig();
    _resetMigrationGuard();
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.WIGOLO_DATA_DIR;
    delete process.env.WIGOLO_PLUGINS_DIR;
    resetConfig();
    try { rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('every tool carries annotations with a non-empty title', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.listTools();
      expect(res.tools).toHaveLength(Object.keys(EXPECTED).length);
      for (const tool of res.tools) {
        expect(tool.annotations, `${tool.name} has no annotations`).toBeDefined();
        expect(typeof tool.annotations?.title).toBe('string');
        expect((tool.annotations?.title as string).length).toBeGreaterThan(0);
      }
    } finally {
      await teardown();
    }
  });

  it('every hint is an explicit boolean, never left undefined', async () => {
    // An absent hint is not the same as `false`: the spec lets a host fall
    // back to its own default, which is what makes tools prompt.
    const { client, teardown } = await connectClient();
    try {
      const res = await client.listTools();
      for (const tool of res.tools) {
        for (const hint of HINT_KEYS) {
          expect(
            typeof tool.annotations?.[hint],
            `${tool.name}.${hint} is not a boolean`,
          ).toBe('boolean');
        }
      }
    } finally {
      await teardown();
    }
  });

  it('matches the pinned hint matrix', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.listTools();
      const actual = Object.fromEntries(
        res.tools.map((t) => [
          t.name,
          {
            readOnlyHint: t.annotations?.readOnlyHint,
            destructiveHint: t.annotations?.destructiveHint,
            idempotentHint: t.annotations?.idempotentHint,
            openWorldHint: t.annotations?.openWorldHint,
          },
        ]),
      );
      expect(actual).toEqual(EXPECTED);
    } finally {
      await teardown();
    }
  });

  it('the three state-changing tools are not advertised as read-only', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.listTools();
      const notReadOnly = res.tools
        .filter((t) => t.annotations?.readOnlyHint === false)
        .map((t) => t.name)
        .sort();
      expect(notReadOnly).toEqual(['cache', 'fetch', 'watch']);
    } finally {
      await teardown();
    }
  });
});
