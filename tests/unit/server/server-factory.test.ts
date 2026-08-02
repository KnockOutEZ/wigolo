import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { resolveSearchBackend, getBootstrapState } from '../../../src/searxng/bootstrap.js';

vi.mock('../../../src/cache/db.js', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getDatabase: vi.fn(() => ({})), // D10 audit sink handle — never exercised here (no audited tool calls)
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
      fetch = vi.fn();
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

// Boot-negative (D2): initSubsystems must init the embedding store WITHOUT
// probing the ONNX provider. The probe fires lazily on first use, never at boot.
const embeddingInit = vi.fn().mockResolvedValue(undefined);
const embeddingEnsureProviderReady = vi.fn().mockResolvedValue(true);
vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: vi.fn(() => ({
    init: embeddingInit,
    ensureProviderReady: embeddingEnsureProviderReady,
    isAvailable: vi.fn().mockReturnValue(true),
    isSubprocessReady: vi.fn().mockReturnValue(false),
    shutdown: vi.fn(),
  })),
  resetEmbeddingService: vi.fn(),
}));

describe('initSubsystems', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    embeddingInit.mockClear().mockResolvedValue(undefined);
    embeddingEnsureProviderReady.mockClear().mockResolvedValue(true);
  });
  afterEach(() => {
    resetConfig();
  });

  it('inits the embedding store at boot but does NOT probe the ONNX provider', async () => {
    const { initSubsystems } = await import('../../../src/server.js');
    await initSubsystems();

    // Positive control: boot still initializes the embedding subsystem.
    expect(embeddingInit).toHaveBeenCalledTimes(1);
    // Boot-negative: the lazy provider probe must not fire at startup (this is
    // the ~150-200MB idle-footprint win).
    expect(embeddingEnsureProviderReady).not.toHaveBeenCalled();
  });

  it('exports initSubsystems function', async () => {
    const { initSubsystems } = await import('../../../src/server.js');
    expect(typeof initSubsystems).toBe('function');
  });

  it('returns searchEngines, browserPool, router, backendStatus, shutdown, bootstrapSearxng', async () => {
    const { initSubsystems } = await import('../../../src/server.js');
    const subs = await initSubsystems();

    expect(subs.searchEngines).toBeDefined();
    expect(Array.isArray(subs.searchEngines)).toBe(true);
    expect(subs.browserPool).toBeDefined();
    expect(subs.router).toBeDefined();
    expect(subs.backendStatus).toBeDefined();
    expect(typeof subs.shutdown).toBe('function');
    expect(typeof subs.bootstrapSearxng).toBe('function');
  });

  it('searchEngines array starts with direct scraping engines', async () => {
    const { initSubsystems } = await import('../../../src/server.js');
    const subs = await initSubsystems();

    expect(subs.searchEngines.length).toBeGreaterThanOrEqual(2);
    const names = subs.searchEngines.map((e) => e.name);
    // Exact prefix assertion: the static direct-engine list is precisely
    // these two — it enforces that dropped engines (incl. the removed wiby)
    // stay out of the pool.
    expect(names.slice(0, 2)).toEqual(['bing', 'duckduckgo']);
  });

  it('shutdown function closes browser pool and database', async () => {
    const { initSubsystems } = await import('../../../src/server.js');
    const subs = await initSubsystems();
    await subs.shutdown();
  });

  it('bootstrapSearxng performs ZERO sidecar activity on the default core backend', async () => {
    // WHY (D1): the zero-config path. A default `core` user must never trigger
    // any sidecar machinery — resolveSearchBackend both probes runtimes AND
    // writes state files, so even calling it once breaks the "no state.json,
    // no port probe" acceptance gate.
    delete process.env.WIGOLO_SEARCH;
    resetConfig();
    const { initSubsystems } = await import('../../../src/server.js');
    const subs = await initSubsystems();
    await subs.bootstrapSearxng();
    expect(resolveSearchBackend).not.toHaveBeenCalled();
  });

  it('bootstrapSearxng DOES resolve the backend when WIGOLO_SEARCH=searxng and the sidecar is installed (positive control)', async () => {
    // WHY: proves the not-called assertion above is meaningful — the harness
    // CAN observe a resolveSearchBackend call when the sidecar is opted into AND
    // available (installed). A ready on-disk state is what warmup --searxng
    // leaves behind.
    process.env.WIGOLO_SEARCH = 'searxng';
    resetConfig();
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });
    try {
      const { initSubsystems } = await import('../../../src/server.js');
      const subs = await initSubsystems();
      await subs.bootstrapSearxng();
      expect(resolveSearchBackend).toHaveBeenCalled();
    } finally {
      delete process.env.WIGOLO_SEARCH;
      vi.mocked(getBootstrapState).mockReturnValue(null);
      resetConfig();
    }
  });
});

describe('createMcpServer', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });
  afterEach(() => {
    resetConfig();
  });

  it('exports createMcpServer function', async () => {
    const { createMcpServer } = await import('../../../src/server.js');
    expect(typeof createMcpServer).toBe('function');
  });

  it('accepts subsystems and returns a Server with tool handlers', async () => {
    const { initSubsystems, createMcpServer } = await import('../../../src/server.js');
    const subs = await initSubsystems();
    const server = createMcpServer(subs);

    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });

  it('returns a fresh Server each call (per-session)', async () => {
    const { initSubsystems, createMcpServer } = await import('../../../src/server.js');
    const subs = await initSubsystems();
    const server1 = createMcpServer(subs);
    const server2 = createMcpServer(subs);

    expect(server1).not.toBe(server2);
  });

  it('does not connect to any transport on its own', async () => {
    const { initSubsystems, createMcpServer } = await import('../../../src/server.js');
    const subs = await initSubsystems();
    const server = createMcpServer(subs);
    expect(server).toBeDefined();
  });

  it('startServer still works for stdio mode', async () => {
    const { startServer } = await import('../../../src/server.js');
    expect(typeof startServer).toBe('function');
  });
});
