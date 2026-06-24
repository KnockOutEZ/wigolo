import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { resetConfig } from '../../../src/config.js';
import { NonceStore } from '../../../src/studio/nonce.js';

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

describe('DaemonHttpServer — S2 nonce→bearer exchange (POST /studio/token)', () => {
  beforeEach(() => { resetConfig(); vi.clearAllMocks(); });
  afterEach(() => { resetConfig(); });

  it('redeems a valid nonce for the session bearer (200 + {token}), never bearer-gated', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const nonces = new NonceStore();
    const nonce = nonces.mint();
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH, nonceStore: nonces });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/studio/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
      });
      expect(resp.status).toBe(200);
      expect((await resp.json()).token).toBe(TOKEN);
    } finally {
      await daemon.stop();
    }
  });

  it('rejects an unknown nonce (401) and leaks no token', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH, nonceStore: new NonceStore() });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/studio/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: 'not-a-real-nonce' }) });
      expect(resp.status).toBe(401);
      expect(await resp.text()).not.toContain(TOKEN);
    } finally {
      await daemon.stop();
    }
  });

  // PIN-S2c (SINGLE-USE), through real /studio/token dispatch. NAMED mutation that REDs: in NonceStore.redeem,
  // stop deleting the matched nonce (allow reuse) → the second redeem succeeds and this assertion fails.
  it('PIN-S2c: a nonce is single-use — the second redeem of the same nonce is 401', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const nonces = new NonceStore();
    const nonce = nonces.mint();
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH, nonceStore: nonces });
    try {
      const url = await daemon.start();
      const first = await fetch(`${url}/studio/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) });
      expect(first.status).toBe(200);
      const second = await fetch(`${url}/studio/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) });
      expect(second.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  // PIN-S2c (TTL), through real dispatch. NAMED mutation that REDs: remove the `now()-issuedAt > ttlMs`
  // expiry check in NonceStore.redeem → an expired nonce redeems 200.
  it('PIN-S2c: an expired nonce is rejected (401)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    let clock = 1_000_000;
    const nonces = new NonceStore({ ttlMs: 5_000, now: () => clock });
    const nonce = nonces.mint();
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH, nonceStore: nonces });
    try {
      const url = await daemon.start();
      clock += 6_000; // advance past the 5s TTL
      const resp = await fetch(`${url}/studio/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) });
      expect(resp.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it('applies the Origin/Host rebind guard to the exchange (cross-origin → 403)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const nonces = new NonceStore();
    const nonce = nonces.mint();
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH, nonceStore: nonces });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/studio/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.com' }, body: JSON.stringify({ nonce }) });
      expect(resp.status).toBe(403);
    } finally {
      await daemon.stop();
    }
  });

  // R0 PIN-COMPLETION (security, the DNS-rebind half). The exchange's Origin/Host guard exists in
  // handleTokenExchange; the sibling test above pins the ORIGIN vector, but the HOST-header vector — the
  // actual DNS-rebinding case the guard documents (a victim browser resolves attacker.com → 127.0.0.1 and
  // sends `Host: attacker.com` with NO cross-origin Origin) — was unpinned. `fetch`/undici forbids setting
  // `Host`, so this drives a raw node:http POST through the SAME real /studio/token dispatch (handleRequest →
  // handleTokenExchange), sending a foreign Host and NO Origin so ONLY the Host branch can reject it.
  // NAMED mutation that REDs (and that the Origin-only test above does NOT catch): delete the
  // `host && !isAllowedHost(...)` block in studio/auth.ts::checkOriginHost → the foreign-Host POST redeems
  // the valid nonce → 200 (token leaked), so this assertion fails.
  it('R0: a foreign-Host nonce-exchange POST is rejected (403) — the DNS-rebind half', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const nonces = new NonceStore();
    const nonce = nonces.mint();
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH, nonceStore: nonces });
    try {
      const url = new URL(await daemon.start());
      const resp = await rawPostToken(url, { Host: 'evil.com' }, JSON.stringify({ nonce }));
      expect(resp.status).toBe(403);
      expect(resp.body).not.toContain(TOKEN);
    } finally {
      await daemon.stop();
    }
  });
});

/** Raw HTTP POST to /studio/token so a forbidden header (Host) can be set verbatim — undici/fetch strips it. */
function rawPostToken(base: URL, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: '/studio/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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
