import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';

// Same subsystem mocks as the daemon http-server test so a real host starts in
// the sandbox without browsers / SearXNG / a real DB.
vi.mock('../../../src/cache/db.js', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
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
vi.mock('../../../src/fetch/http-client.js', () => ({ httpFetch: vi.fn() }));
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

import { DaemonHttpServer } from '../../../src/daemon/http-server.js';
import { writeHandle, removeHandle } from '../../../src/studio/handle.js';
import { studioProxyFromHandle, DaemonProxy } from '../../../src/daemon/proxy.js';

describe('studio proxy ↔ host round-trip', () => {
  let dataDir: string;
  beforeEach(() => {
    resetConfig();
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-rt-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetConfig();
  });

  it('a handle-discovered proxy call actually traverses to the host (counter proves it) and returns a result', async () => {
    const token = 'round-trip-token-xyz';
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: { token, host: '127.0.0.1' } });
    const endpoint = await daemon.start();
    try {
      writeHandle({ id: 'sid', endpoint, token, pid: process.pid }, dataDir);
      const proxy = studioProxyFromHandle(dataDir);
      expect(proxy).not.toBeNull();

      const before = daemon.getMcpRequestCount();
      const result = await proxy!.callTool('cache', { action: 'stats' });

      // Proof the call reached the HOST (not run locally): the host's request
      // counter advanced. cache stats would return ok:true even locally, so the
      // counter — not the result shape — is what proves the round-trip.
      expect(daemon.getMcpRequestCount()).toBeGreaterThan(before);
      expect(result).toBeDefined();
    } finally {
      removeHandle(dataDir);
      await daemon.stop();
    }
  }, 20_000);

  it('rejects a proxy call carrying the wrong bearer token (auth enforced end-to-end)', async () => {
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: { token: 'correct-token', host: '127.0.0.1' } });
    const endpoint = await daemon.start();
    try {
      const proxy = new DaemonProxy(endpoint, 'wrong-token');
      await expect(proxy.callTool('cache', { action: 'stats' })).rejects.toThrow();
    } finally {
      await daemon.stop();
    }
  }, 20_000);
});
