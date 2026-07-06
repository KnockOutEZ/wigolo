import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { resetConfig } from '../../../src/config.js';

// Same network-free subsystem mocks the sibling daemon suites use.
vi.mock('../../../src/cache/db.js', () => ({ initDatabase: vi.fn(), closeDatabase: vi.fn(), getDatabase: vi.fn(() => ({})) }));
vi.mock('../../../src/fetch/browser-pool.js', () => {
  class M { shutdown = vi.fn().mockResolvedValue(undefined); fetchWithBrowser = vi.fn(); getConfiguredTypes = vi.fn().mockReturnValue(['chromium']); getStats = vi.fn().mockReturnValue([]); }
  return { MultiBrowserPool: M, BrowserPool: class extends M { acquire = vi.fn(); release = vi.fn(); } };
});
vi.mock('../../../src/fetch/http-client.js', () => ({ httpFetch: vi.fn() }));
vi.mock('../../../src/fetch/router.js', () => ({ SmartRouter: class { constructor(_a: unknown, _b: unknown) {} fetch = vi.fn(); getDomainStats = vi.fn(); } }));
vi.mock('../../../src/searxng/bootstrap.js', () => ({ resolveSearchBackend: vi.fn().mockResolvedValue({ type: 'scraping' }), bootstrapNativeSearxng: vi.fn(), getBootstrapState: vi.fn().mockReturnValue(null) }));
vi.mock('../../../src/searxng/process.js', () => ({ SearxngProcess: vi.fn().mockImplementation(() => ({ start: vi.fn().mockResolvedValue(null), stop: vi.fn().mockResolvedValue(undefined), getUrl: vi.fn().mockReturnValue(null) })) }));
vi.mock('../../../src/searxng/docker.js', () => ({ DockerSearxng: vi.fn().mockImplementation(() => ({ start: vi.fn().mockResolvedValue(null), stop: vi.fn().mockResolvedValue(undefined) })) }));

const TOKEN = 'phase7a-s2-session-bearer-abcdefghij1234567890';
const AUTH = { token: TOKEN, host: '127.0.0.1' };

// The v1 nonce→bearer exchange (POST /studio/token) was deleted with the served webapp. What survives here is
// the WS-upgrade bearer guard (PIN-S2a/S2b) — the studio host's onUpgrade path still authorizes upgrades via
// Origin/Host + subprotocol bearer, independent of the deleted nonce route.
describe('DaemonHttpServer — S2 WS upgrade carries the bearer ONLY via subprotocol', () => {
  beforeEach(() => { resetConfig(); vi.clearAllMocks(); });
  afterEach(() => { resetConfig(); });

  async function startWithUpgrade() {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const wss = new WebSocketServer({ noServer: true });
    const onUpgrade = vi.fn((req: IncomingMessage, socket: Duplex, head: Buffer) => {
      wss.handleUpgrade(req, socket, head, (ws) => ws.send('hello'));
    });
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH, onUpgrade });
    const url = await daemon.start();
    return { daemon, wss, onUpgrade, wsUrl: url.replace('http://', 'ws://') };
  }
  function connect(url: string, protocols: string[]): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, protocols);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  // PIN-S2b, through real handleUpgrade dispatch. NAMED mutation that REDs: relax checkAuthSubprotocol to
  // pass when no `wigolo.bearer.*` entry is present → this upgrade is accepted and onUpgrade fires.
  it('PIN-S2b: an upgrade offering only wigolo.stream (no bearer subprotocol) is REJECTED', async () => {
    const { daemon, wss, onUpgrade, wsUrl } = await startWithUpgrade();
    try {
      await expect(connect(`${wsUrl}/studio/x/stream`, ['wigolo.stream'])).rejects.toBeDefined();
      expect(onUpgrade).not.toHaveBeenCalled();
    } finally {
      wss.close();
      await daemon.stop();
    }
  });

  // PIN-S2a (server complement), through real handleUpgrade dispatch. The bearer must authenticate ONLY via
  // subprotocol — a token presented in the URL query must NOT authenticate. NAMED mutation that REDs: make
  // the upgrade auth also accept a `?token=`/query bearer → this query-only upgrade is accepted.
  it('PIN-S2a: a token presented only in the URL query (no subprotocol bearer) is REJECTED', async () => {
    const { daemon, wss, onUpgrade, wsUrl } = await startWithUpgrade();
    try {
      await expect(connect(`${wsUrl}/studio/x/stream?token=${TOKEN}`, ['wigolo.stream'])).rejects.toBeDefined();
      expect(onUpgrade).not.toHaveBeenCalled();
    } finally {
      wss.close();
      await daemon.stop();
    }
  });
});
