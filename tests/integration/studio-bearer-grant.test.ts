import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { resetConfig } from '../../src/config.js';
import type { LaunchedSessionBrowser } from '../../src/studio/session-browser.js';

/**
 * S7-bearer — the {t:'grant'} BEARER BOUNDARY, RUNNABLE (no browser), against the REAL bearer-gated daemon
 * front-door upgrade. This is an INTEGRATION test (NOT in tests/unit) precisely because the unit harness
 * (cli/studio.test.ts) MOCKS DaemonHttpServer (no listener) and uses connectToHostHub, which bypasses the
 * daemon bearer gate. Here the real DaemonHttpServer listens, so a node WS client drives the actual
 * /studio/<id>/stream upgrade with the wigolo.stream + wigolo.bearer.<token> subprotocols.
 *
 * Closes the gap that the bearer rejection of a forged {t:'grant'} was previously covered ONLY by the
 * unrunnable headed page-forge proof. Real upgrade + real codec ingress — never a hand-rolled accepted frame.
 *
 * getEmbedProvider is mocked (avoid the ONNX subprocess); DaemonHttpServer is NOT mocked (the whole point).
 */
vi.mock('../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => ({ embed: vi.fn(), dim: 384, modelId: 'BGE-small-en-v1.5' })),
}));

const { startStudioHost } = await import('../../src/cli/studio.js');

const fakeBrowserLauncher = async (): Promise<LaunchedSessionBrowser> =>
  ({
    browser: { close: async () => {}, on: () => {} },
    context: { close: async () => {} },
    page: { close: async () => {}, goto: async () => null, on: () => {} },
    cdp: { send: async () => ({}), on: () => {}, off: () => {} },
  }) as unknown as LaunchedSessionBrowser;

/** Attempt a REAL upgrade against the daemon front-door; resolve 'open' or 'rejected'. Generous timeout so a
 *  slow first handshake under suite load is not miscounted (a timeout surfaces as its own value, not 'open'). */
function tryUpgrade(wsUrl: string, protocols: string[]): Promise<{ outcome: 'open' | 'rejected' | 'timeout'; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, protocols);
    let settled = false;
    const done = (outcome: 'open' | 'rejected' | 'timeout') => { if (!settled) { settled = true; resolve({ outcome, ws }); } };
    ws.on('open', () => done('open'));
    ws.on('error', () => done('rejected'));
    ws.on('unexpected-response', () => done('rejected'));
    setTimeout(() => done('timeout'), 8000);
  });
}

const waitFor = async (pred: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
};

describe('studio {t:grant} bearer boundary — real daemon front-door (runnable, no browser)', () => {
  beforeEach(() => {
    resetConfig();
    _resetMigrationGuard();
    initDatabase(':memory:');
  });
  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    resetConfig();
  });

  it('S7-bearer PIN: only a correct-bearer upgrade reaches the hub; a forged {t:grant} (no/wrong bearer) is rejected and never writes the store; a correct-bearer {t:grant} writes it', async () => {
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, browserLauncher: fakeBrowserLauncher });
    const wsUrl = host.endpoint.replace('http://', 'ws://') + `/studio/${host.session.id}/stream`;
    const tok = host.session.token;
    const sockets: WebSocket[] = [];
    // Attempt an upgrade; if it OPENS (the only way a forged conn opens is if the bearer gate is broken),
    // immediately push a forged {t:grant} so a broken gate proves itself by WRITING the store.
    const attemptForgedGrant = async (protocols: string[], domain: string) => {
      const r = await tryUpgrade(wsUrl, protocols);
      sockets.push(r.ws);
      if (r.outcome === 'open') r.ws.send(JSON.stringify({ t: 'grant', entries: [{ domain, actionType: 'click', riskTier: 'money' }] }));
      return r.outcome;
    };
    try {
      // (a) NO bearer + (b) WRONG bearer ⇒ rejected at the daemon front-door (401, never reaches the hub).
      const noBearerOutcome = await attemptForgedGrant(['wigolo.stream'], 'evil-a.example');
      const wrongOutcome = await attemptForgedGrant(['wigolo.stream', 'wigolo.bearer.WRONG-TOKEN'], 'evil-b.example');
      await new Promise((r) => setTimeout(r, 250)); // give any (wrongly-accepted) forged grant time to land

      // (d) the BRIGHT-LINE store assertion — a forged-bearer connection NEVER writes the scope store.
      // Under the bearer-disabled mutation this REDs: the no-bearer upgrade opens, its {t:grant} writes → size 1.
      expect(host.preGrant.size, 'no forged-bearer connection wrote the scope store').toBe(0);
      expect(noBearerOutcome, 'no-bearer upgrade is rejected').toBe('rejected');
      expect(wrongOutcome, 'wrong-bearer upgrade is rejected').toBe('rejected');

      // (c) CORRECT bearer ⇒ accepted; a {t:grant} over it writes the PreGrantStore (real codec ingress).
      const ok = await tryUpgrade(wsUrl, ['wigolo.stream', `wigolo.bearer.${tok}`]);
      sockets.push(ok.ws);
      expect(ok.outcome, 'correct-bearer upgrade is accepted').toBe('open');
      ok.ws.send(JSON.stringify({ t: 'grant', entries: [{ domain: 'shop.example', actionType: 'click', riskTier: 'money' }] }));
      await waitFor(() => host.preGrant.size === 1);
      expect(host.preGrant.size, 'correct-bearer {t:grant} writes the store').toBe(1);
      expect(host.preGrant.matches({ domain: 'shop.example', actionType: 'click', riskTier: 'money' })).toBe(true);
    } finally {
      for (const s of sockets) { try { s.close(); } catch { /* ignore */ } } // close BEFORE stop so a forged-open socket can't hang teardown
      await host.daemon.stop();
    }
  }, 30_000);
});
