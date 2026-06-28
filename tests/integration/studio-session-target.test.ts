import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../src/config.js';
import { getDatabase, closeDatabase } from '../../src/cache/db.js';
import { _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { DaemonProxy } from '../../src/daemon/proxy.js';
import type { LaunchedSessionBrowser } from '../../src/studio/session-browser.js';

/**
 * D19 — session_id-targeting on fetch/extract/crawl, RUNNABLE (no headed browser) against the REAL
 * bearer-gated daemon + REAL MCP dispatch. Mirrors studio-bearer-grant.test.ts: the real DaemonHttpServer
 * listens, a real DaemonProxy MCP client (the SAME wire the stdio server's cross-process forward produces)
 * drives `POST /mcp`, and the host runs the real createMcpServer CallTool dispatch → runSessionFetch →
 * getSessionDrive(id).gatedNavigate. A FAKE session-browser launcher stands in for Playwright: its page.goto
 * records navigations and its CDP Runtime.evaluate returns canned HTML, so the GATING / ROUTING / TRUSTED-0 /
 * SSRF / CONTRACT pins run with no browser. (The actual-navigation e2e — real page bytes — is the headed lane.)
 *
 * getEmbedProvider is mocked (no ONNX subprocess); DaemonHttpServer is NOT mocked (the whole point).
 */
vi.mock('../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => ({ embed: vi.fn(), dim: 384, modelId: 'BGE-small-en-v1.5' })),
}));

const { startStudioHost } = await import('../../src/cli/studio.js');

const SESSION_HTML =
  '<html><head><title>Live Session Page</title></head><body><main><h1>hello from the live session</h1>' +
  '<p>This is authenticated co-browse content the agent fetched through the session.</p></main></body></html>';

/** A fake headed-browser launcher: page.goto records nav (count + last url); CDP Runtime.evaluate returns canned HTML. */
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

describe('D19 session_id-targeting on fetch/extract/crawl (real daemon + dispatch, no browser)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wigolo-d19-'));
    process.env.WIGOLO_DATA_DIR = tmp; // the host's initSubsystems inits + migrates the db here; getDatabase() returns it
    resetConfig();
    _resetMigrationGuard();
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch {
      /* already closed */
    }
    delete process.env.WIGOLO_DATA_DIR;
    resetConfig();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function makeHost(): Promise<{ host: Awaited<ReturnType<typeof startStudioHost>>; state: ReturnType<typeof makeFakeLauncher>['state'] }> {
    const { launcher, state } = makeFakeLauncher();
    const host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, dataDir: tmp, browserLauncher: launcher });
    return { host, state };
  }

  // PIN 1 + PIN 6 — navigate-class gating + the GATED-ACCESSOR route. The primary session is human-spawned
  // (holder='human'), so a session fetch by the agent is BLOCKED (not_holder) and the session browser is NEVER
  // navigated. PIN 1 mutation: skip assertCanDrive inside session-drive.gatedNavigate ⇒ it navigates ⇒ RED.
  // PIN 6 mutation: bypass the drive.gatedNavigate route in runSessionFetch (force nav ok) ⇒ content returned ⇒ RED.
  it('PIN 1+6: a session fetch when the human holds is BLOCKED (not_holder) — the gated drive refuses, browser never navigates', async () => {
    const { host, state } = await makeHost();
    try {
      const r = await callTool(host, 'fetch', { url: 'https://example.com', session_id: host.session.id });
      expect(r.isError, 'a non-holder session fetch is a tool error').toBe(true);
      expect(r.body.error, 'blocked at the control-token gate').toBe('not_holder');
      expect(state.gotoCalls, 'the session browser was never navigated').toBe(0);
    } finally {
      await host.daemon.stop();
    }
  }, 30_000);

  // PIN 1 (composes with S5) + PIN 3 — once the human grants control to the agent (holder='agent'), the SAME
  // gate ALLOWS the navigate, the page is read, and the content is persisted content_trusted=0 (captureFromPage,
  // the trusted-0 writer). PIN 3 mutation: route insertSessionContent through captureHumanNote (trusted=1) ⇒
  // the persisted row flips to content_trusted=1 ⇒ RED.
  it('PIN 1(allowed)+3: an agent-held session fetch navigates, returns the live content, and persists it content_trusted=0', async () => {
    const { host, state } = await makeHost();
    try {
      host.controller.handleControl({ op: 'grant', to: 'agent' }); // the human grants the turn to the agent
      const r = await callTool(host, 'fetch', { url: 'https://example.com/page', session_id: host.session.id });
      expect(r.isError, 'an agent-held session fetch succeeds').toBe(false);
      expect(String(r.body.markdown), 'the live session content is returned').toContain('hello from the live session');
      expect(state.gotoCalls, 'the session browser navigated').toBeGreaterThan(0);

      const row = getDatabase()
        .prepare('SELECT artifact_type, content_trusted FROM studio_artifacts ORDER BY id DESC LIMIT 1')
        .get() as { artifact_type: string; content_trusted: number } | undefined;
      expect(row, 'the session fetch persisted an artifact').toBeTruthy();
      expect(row!.content_trusted, 'session-fetched content is trusted-0 (page bytes are data, never instructions)').toBe(0);
    } finally {
      await host.daemon.stop();
    }
  }, 30_000);

  // PIN 2 — an unknown/closed session_id is an EXPLICIT error, NEVER a silent ephemeral fallback. Mutation:
  // fall back to the ephemeral router when getSessionDrive returns undefined ⇒ an ephemeral result (not the
  // no_such_session error) ⇒ RED.
  it('PIN 2: an unknown session_id is an explicit no_such_session error (never a silent ephemeral fetch)', async () => {
    const { host } = await makeHost();
    try {
      const r = await callTool(host, 'fetch', { url: 'https://example.com', session_id: 'does-not-exist' });
      expect(r.isError).toBe(true);
      expect(r.body.error, 'explicit error, not an ephemeral downgrade').toBe('no_such_session');
    } finally {
      await host.daemon.stop();
    }
  }, 30_000);

  // PIN 4 — the SSRF fence holds on session-targeted navigation: even when the agent holds control (and even
  // if private nav were granted), cloud-metadata (169.254.169.254 = link_local) is blocked, and the browser is
  // never navigated. Mutation: bypass the SSRF guard in gatedNavigate (call browser.navigate directly, skipping
  // navigateSession→guardNavigation) ⇒ the blocked target navigates ⇒ RED.
  it('PIN 4: a session fetch of a cloud-metadata address is SSRF-blocked even with the agent holding', async () => {
    const { host, state } = await makeHost();
    try {
      host.controller.handleControl({ op: 'grant', to: 'agent' });
      const r = await callTool(host, 'fetch', { url: 'http://169.254.169.254/latest/meta-data/', session_id: host.session.id });
      expect(r.isError).toBe(true);
      expect(r.body.error, 'cloud-internal is never reachable').toBe('navigation_blocked');
      expect(state.gotoCalls, 'the blocked target was never navigated (guard runs before goto)').toBe(0);
    } finally {
      await host.daemon.stop();
    }
  }, 30_000);

  // PIN 5 — the CONTRACT: a no-session_id fetch is UNCHANGED (the ephemeral path). With mode:'cache' it returns
  // the deterministic ephemeral cache_miss and the session browser is never touched. Mutation: make
  // isSessionTargeted always true ⇒ a no-session_id fetch routes to the session path ⇒ no_such_session ⇒ RED.
  it('PIN 5: a fetch without session_id uses the ephemeral path unchanged (cache_miss), never the session drive', async () => {
    const { host, state } = await makeHost();
    try {
      const r = await callTool(host, 'fetch', { url: 'https://example.com', mode: 'cache' });
      expect(r.isError).toBe(true);
      expect(r.body.error, 'the ephemeral cache path ran (not the session path)').toBe('cache_miss');
      expect(state.gotoCalls, 'the session browser was never navigated for an ephemeral fetch').toBe(0);
    } finally {
      await host.daemon.stop();
    }
  }, 30_000);

  // BONUS — extract on a session reads the CURRENT page WITHOUT navigating (the sole token-free read). No
  // control-token gate is consulted (a read, not a drive); the session browser is never navigated.
  it('extract(session_id) reads the current page without navigating (token-free read)', async () => {
    const { host, state } = await makeHost();
    try {
      const r = await callTool(host, 'extract', { mode: 'metadata', session_id: host.session.id });
      expect(r.isError, 'extract reads the current page even when the human holds (no drive, no gate)').toBe(false);
      expect(state.gotoCalls, 'extract never navigates — it reads the current page').toBe(0);
    } finally {
      await host.daemon.stop();
    }
  }, 30_000);
});
