import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetConfig } from '../../src/config.js';
import { installActivated } from '../unit/server/activation-fixture.js';
import { closeDatabase } from '../../src/cache/db.js';
import { _resetBackgroundIndexQueueForTest } from '../../src/embedding/background-queue.js';
import { _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { DaemonProxy } from '../../src/daemon/proxy.js';
import { removeHandle, writeHandle } from '../../src/companion/handle.js';
import { SESSION_TARGET_ROUTE } from '../../src/companion-contract/session-target.js';
import type { LaunchedSessionBrowser } from '../../src/studio/session-browser.js';

/**
 * EXTRACT seam 5 — session_id-targeting on fetch/extract/crawl, RUNNABLE against the REAL bearer-gated
 * daemon + REAL MCP dispatch. A real DaemonProxy MCP client (the same wire the stdio server produces)
 * drives `POST /mcp`, the host runs the real createMcpServer CallTool dispatch, and the dispatch reaches
 * the session-target FORWARDING CLIENT — which is all core owns of this seam now.
 *
 * What moved, and why this file changed shape: the composition that drives a live session (the
 * control-token gate, the SSRF-fenced navigate, the trusted-0 capture, the credential-page capture
 * refusal) belongs to the side that owns the browser. Its pins run against that side, in the app's own
 * e2e (spec §10). Asserting them here would only prove that a stand-in we wrote answers the way we wrote
 * it to. What IS core's, and is pinned below, is the boundary:
 *
 *  - a session-targeted call with no companion paired refuses EXPLICITLY and never downgrades to an
 *    anonymous ephemeral fetch (the property the old PIN 2 protected, at the new boundary);
 *  - a paired call is forwarded verbatim over the contract route, bearing the handle's token;
 *  - the companion's own typed refusal reaches the agent through the real MCP error envelope with its
 *    machine code intact, rather than being re-narrated here;
 *  - a fetch WITHOUT session_id still takes the ephemeral path, untouched (old PIN 5, kept verbatim);
 *  - core never drives a local session browser for these calls, whatever it has lying around.
 *
 * getEmbedProvider is mocked (no ONNX subprocess); DaemonHttpServer is NOT mocked (the whole point).
 */
vi.mock('../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => ({ embed: vi.fn(), dim: 384, modelId: 'BGE-small-en-v1.5' })),
}));

const { startStudioHost } = await import('../../src/cli/studio.js');

const SESSION_HTML =
  '<html><head><title>Live Session Page</title></head><body><main><h1>hello from the live session</h1></main></body></html>';

/** A fake headed-browser launcher: page.goto records nav. Its ONLY job here is to prove nav never happens. */
function makeFakeLauncher() {
  const state = { gotoCalls: 0, currentUrl: 'about:blank' };
  const launcher = async (): Promise<LaunchedSessionBrowser> =>
    ({
      browser: { close: async () => {}, on: () => {} },
      context: { close: async () => {}, storageState: async () => ({ cookies: [], origins: [] }) },
      page: {
        close: async () => {},
        goto: async (url: string) => {
          state.gotoCalls++;
          state.currentUrl = url;
          return null;
        },
        on: () => {},
        url: () => state.currentUrl,
      },
      cdp: {
        send: async (method: string) => (method === 'Runtime.evaluate' ? { result: { value: SESSION_HTML } } : {}),
        on: () => {},
        off: () => {},
      },
    }) as unknown as LaunchedSessionBrowser;
  return { launcher, state };
}

interface CompanionCall {
  url?: string;
  auth?: string;
  body: unknown;
}

/** A stand-in companion: the far side of the session-target wire, recording exactly what core sent it. */
function makeCompanion(): {
  start: () => Promise<{ endpoint: string }>;
  stop: () => Promise<void>;
  calls: CompanionCall[];
  reply: (body: unknown, status?: number) => void;
} {
  const calls: CompanionCall[] = [];
  let next: { body: unknown; status: number } = { body: { ok: true, data: {} }, status: 200 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      calls.push({ url: req.url, auth: req.headers.authorization, body: raw === '' ? undefined : JSON.parse(raw) });
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });
  return {
    calls,
    reply: (body, status = 200) => {
      next = { body, status };
    },
    start: async () => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    },
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type ToolReply = { isError: boolean; body: Record<string, unknown> };

/** Drive a real MCP tool call against the host over the bearer-gated front door (the cross-process wire). */
async function callTool(
  host: Awaited<ReturnType<typeof startStudioHost>>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolReply> {
  const proxy = new DaemonProxy(host.endpoint, host.session.token);
  const res = (await proxy.callTool(name, args)) as { content: Array<{ text: string }>; isError: boolean };
  return { isError: res.isError, body: JSON.parse(res.content[0].text) as Record<string, unknown> };
}

describe('seam 5: session_id-targeting forwards over the companion wire (real daemon + dispatch)', () => {
  let tmp: string;
  let restoreActivation: () => void;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wigolo-st-'));
    process.env.WIGOLO_DATA_DIR = tmp;
    resetConfig();
    _resetMigrationGuard();
    // A fresh temp data dir is an un-activated install, so every tools/call here would return the
    // activation refusal instead of the envelope under test. The gate's own arms live in
    // tests/unit/server/activation-gate.test.ts.
    restoreActivation = installActivated();
  });

  afterEach(() => {
    restoreActivation();
    try {
      closeDatabase();
    } catch {
      /* already closed */
    }
    // The embedding job queue opens <dataDir>/jobs.db through a module singleton the daemon never owns,
    // so closeDatabase() does not close it. POSIX unlinks an open file happily; Windows raises EBUSY.
    _resetBackgroundIndexQueueForTest();
    delete process.env.WIGOLO_DATA_DIR;
    resetConfig();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function makeHost(): Promise<{ host: Awaited<ReturnType<typeof startStudioHost>>; state: ReturnType<typeof makeFakeLauncher>['state'] }> {
    const { launcher, state } = makeFakeLauncher();
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, dataDir: tmp, browserLauncher: launcher });
    return { host, state };
  }

  it('UNPAIRED: a session-targeted fetch is an explicit companion_unavailable, never a silent ephemeral fetch', async () => {
    const { host, state } = await makeHost();
    try {
      // No companion: whatever this process happens to have running, core is a CLIENT of this seam now
      // and there is nobody on the other end of the wire.
      removeHandle(tmp);
      const r = await callTool(host, 'fetch', { url: 'https://example.com', session_id: 'sess-1' });
      expect(r.isError, 'a session fetch with no companion is a tool error').toBe(true);
      expect(r.body.error_reason, 'explicit refusal, not an ephemeral downgrade').toBe('companion_unavailable');
      expect(state.gotoCalls, 'no browser was driven — and certainly not a local one').toBe(0);
    } finally {
      await host.daemon.stop();
    }
  }, 30_000);

  it('PAIRED: the call is forwarded verbatim to the contract route with the handle bearer token', async () => {
    const { host, state } = await makeHost();
    const companion = makeCompanion();
    const { endpoint } = await companion.start();
    try {
      writeHandle({ id: 'c1', endpoint, token: 'companion-tok', pid: 1, instanceId: 'companion' }, tmp);
      companion.reply({ ok: true, data: { url: 'https://example.com/live', title: 'Live', markdown: 'hello from the live session' } });

      const r = await callTool(host, 'fetch', { url: 'https://example.com', session_id: 'sess-9' });

      expect(companion.calls).toHaveLength(1);
      expect(companion.calls[0]!.url, 'addressed the contract route').toBe(SESSION_TARGET_ROUTE);
      expect(companion.calls[0]!.auth, 'bore the handle token, not the daemon session token').toBe('Bearer companion-tok');
      expect(companion.calls[0]!.body).toMatchObject({ op: 'fetch', session_id: 'sess-9', input: { url: 'https://example.com', session_id: 'sess-9' } });
      expect(r.isError).toBe(false);
      expect(String(r.body.markdown), 'the companion page came back through the real envelope').toContain('hello from the live session');
      expect(state.gotoCalls, 'core drove no browser of its own').toBe(0);
    } finally {
      await companion.stop();
      await host.daemon.stop();
    }
  }, 30_000);

  it("PAIRED: a companion refusal reaches the agent with its machine code intact, in the companion's words", async () => {
    const { host } = await makeHost();
    const companion = makeCompanion();
    const { endpoint } = await companion.start();
    try {
      writeHandle({ id: 'c1', endpoint, token: 'companion-tok', pid: 1, instanceId: 'companion' }, tmp);
      // The refusal a companion authors when the human is driving. Re-narrating it here would strip the
      // reason the human needs; the envelope swap (error ⇄ error_reason) is the only thing core does to it.
      companion.reply(
        { ok: false, error: 'not_holder', error_reason: 'The human holds control of this session.', stage: 'fetch', hint: 'Observe and wait for a grant.' },
        403,
      );
      const r = await callTool(host, 'fetch', { url: 'https://example.com', session_id: 'sess-9' });
      expect(r.isError).toBe(true);
      expect(r.body.error_reason, 'the machine code survives the envelope').toBe('not_holder');
      expect(String(r.body.error), "the companion's own sentence survives too").toContain('The human holds control');
      expect(r.body.hint).toBe('Observe and wait for a grant.');
    } finally {
      await companion.stop();
      await host.daemon.stop();
    }
  }, 30_000);

  it('PAIRED: a session-targeted crawl refusal comes back in the crawl shape, not a stage-error envelope', async () => {
    const { host } = await makeHost();
    const companion = makeCompanion();
    const { endpoint } = await companion.start();
    try {
      writeHandle({ id: 'c1', endpoint, token: 'companion-tok', pid: 1, instanceId: 'companion' }, tmp);
      companion.reply({ ok: false, error: 'navigation_blocked', error_reason: 'cloud-internal is never allowed', stage: 'crawl' }, 403);
      const r = await callTool(host, 'crawl', { url: 'http://169.254.169.254/latest/meta-data/', session_id: 'sess-9' });
      expect(r.isError).toBe(true);
      expect(String(r.body.error), 'the crawl envelope carries its failure in `error`').toContain('navigation_blocked');
      expect(r.body.pages, 'no pages are invented for a refused crawl').toEqual([]);
    } finally {
      await companion.stop();
      await host.daemon.stop();
    }
  }, 30_000);

  it('the CONTRACT: a fetch without session_id uses the ephemeral path unchanged (cache_miss), and forwards nothing', async () => {
    // Mutation: make isSessionTargeted always true ⇒ a no-session_id fetch routes to the wire ⇒ RED.
    const { host, state } = await makeHost();
    const companion = makeCompanion();
    const { endpoint } = await companion.start();
    try {
      writeHandle({ id: 'c1', endpoint, token: 'companion-tok', pid: 1, instanceId: 'companion' }, tmp);
      const r = await callTool(host, 'fetch', { url: 'https://example.com', mode: 'cache' });
      expect(r.isError).toBe(true);
      expect(r.body.error_reason, 'the ephemeral cache path ran (not the session path)').toBe('cache_miss');
      expect(companion.calls, 'a paired companion is not consulted for an ordinary fetch').toHaveLength(0);
      expect(state.gotoCalls).toBe(0);
    } finally {
      await companion.stop();
      await host.daemon.stop();
    }
  }, 30_000);
});
