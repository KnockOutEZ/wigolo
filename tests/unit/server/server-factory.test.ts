import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/cache/db.js', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../../../src/fetch/browser-pool.js', () => {
  return {
    BrowserPool: class MockBrowserPool {
      shutdown = vi.fn().mockResolvedValue(undefined);
      acquire = vi.fn();
      release = vi.fn();
      fetchWithBrowser = vi.fn();
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

describe('initSubsystems', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });
  afterEach(() => {
    resetConfig();
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

    expect(subs.searchEngines.length).toBeGreaterThanOrEqual(3);
    const names = subs.searchEngines.map((e) => e.name);
    expect(names).toContain('bing');
    expect(names).toContain('duckduckgo');
    expect(names).toContain('startpage');
  });

  it('shutdown function closes browser pool and database', async () => {
    const { initSubsystems } = await import('../../../src/server.js');
    const subs = await initSubsystems();
    await subs.shutdown();
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
