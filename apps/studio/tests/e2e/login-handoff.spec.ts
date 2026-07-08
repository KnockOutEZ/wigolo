import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ElectronApplication } from 'playwright';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { launchStudio } from './launch';
import { readHandle, DaemonProxy } from 'wigolo/studio';

// GATED (RUN_STUDIO_E2E) — the P5 login-wall handoff arc end-to-end through the REAL embedded gateway + drive
// engine + Electron partition. A loopback fixture serves a credential page (password field) at `/` and a
// plain page at `/home`; the agent (granted onto localhost) navigates to the wall → the host reclaims to the
// human + the agent's studio_observe carries login_handoff:in_progress with page content EXCLUDED; we then
// simulate the human completing the login (leave the credential context + a real new cookie on the session)
// and assert the agent is re-granted (login_handoff:completed). When an OS keychain is present, the encrypted
// origin-scoped profile is written and asserted to contain NO cleartext; when absent (common headless CI) the
// persist fail-closes (nothing written) while the ARC still completes — BOTH branches assert the arc.
const RUN = !!process.env.RUN_STUDIO_E2E;
const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');

interface ToolResult { content: Array<{ type: string; text: string }>; isError: boolean }
const body = (r: unknown) => JSON.parse((r as ToolResult).content[0].text) as Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)('studio login-wall handoff (e2e, real gateway + partition)', () => {
  let app: ElectronApplication;
  let dataDir: string;
  let endpoint: string;
  let token: string;
  let loopback: Server;
  let loopbackUrl: string;
  let loopbackOrigin: string;

  beforeAll(async () => {
    loopback = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      if (req.url && req.url.startsWith('/home')) {
        res.end('<!doctype html><title>home</title><h1>Welcome back</h1><p>You are signed in.</p>');
      } else {
        res.end('<!doctype html><title>sign in</title><h1>Sign in</h1><form><input type="password" name="pw" aria-label="Password"></form>');
      }
    });
    await new Promise<void>((r) => loopback.listen(0, '127.0.0.1', r));
    const addr = loopback.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    loopbackUrl = `http://127.0.0.1:${port}/`;
    loopbackOrigin = `http://127.0.0.1:${port}`;
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-studio-login-e2e-'));
    app = await launchStudio({ args: [APP_MAIN], env: { ...process.env, WIGOLO_DATA_DIR: dataDir } });
    await app.firstWindow();
    const started = Date.now();
    let handle = readHandle(dataDir);
    while (!handle && Date.now() - started < 30_000) { await sleep(250); handle = readHandle(dataDir); }
    if (!handle) throw new Error('gateway handle never published');
    endpoint = handle.endpoint;
    token = handle.token;
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => loopback?.close(() => r()));
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function resetSessions(proxy: DaemonProxy): Promise<void> {
    const list = body(await proxy.callTool('studio_list', {}));
    for (const s of (list.sessions as Array<{ id: string }>) ?? []) await proxy.callTool('studio_close', { session_id: s.id });
    await sleep(200);
  }

  it('agent hits a login wall → reclaim + login_handoff:in_progress (content excluded) → human completes → re-granted; profile encrypted-at-rest when a keychain is present', async () => {
    const proxy = new DaemonProxy(endpoint, token);
    await resetSessions(proxy);
    await proxy.callTool('studio_open', { startUrl: loopbackUrl });

    // Human grants the agent onto localhost for this session (the real renderer seam) so it can reach the wall.
    const win = await app.firstWindow();
    await win.evaluate(() => (window as unknown as { studio: { grantLocalhost(): Promise<boolean> } }).studio.grantLocalhost());
    await sleep(200);

    // The agent navigates to the credential page → afterAgentAct detects the wall → reclaim to the human.
    const nav = body(await proxy.callTool('studio_act', { action: 'navigate', url: loopbackUrl }));
    expect(nav.ok).toBe(true);
    await sleep(400); // let afterAgentAct run detectWall

    // studio_observe: the agent sees ONLY the handoff signal + credentialContext — page a11y content excluded.
    const obs = body(await proxy.callTool('studio_observe', {}));
    expect(obs.credentialContext).toBe(true);
    expect(obs.elements).toEqual([]);
    expect(obs.login_handoff).toMatchObject({ state: 'in_progress', doNotRetry: true });

    // The agent is fenced out while the human holds: another act is refused.
    const fenced = body(await proxy.callTool('studio_act', { action: 'navigate', url: loopbackUrl }));
    expect(fenced.error_reason).toBe('not_holder');

    // Simulate the human completing the login: a real new session cookie appears for the wall origin AND the
    // page leaves the credential context (navigate the session tab to the plain /home page). Host-side +
    // deterministic (no page-timer race); the tab already holds the localhost grant.
    const secret = `WIGOLO_SECRET_${randomUUID()}`;
    await app.evaluate(async ({ webContents }, arg) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('127.0.0.1'));
      if (!wc) throw new Error('no loopback session tab');
      await wc.session.cookies.set({ url: arg.url, name: 'sid', value: arg.secret, httpOnly: true, secure: false });
      await wc.loadURL(arg.url + 'home');
    }, { url: loopbackUrl, secret });

    // The bounded completion poll (2s) detects: left credential ctx + meaningful storage delta → completed + re-grant.
    let completed = false;
    for (let i = 0; i < 40 && !completed; i++) {
      await sleep(300);
      const o = body(await proxy.callTool('studio_observe', {}));
      completed = (o.login_handoff as { state?: string } | undefined)?.state === 'completed';
    }
    expect(completed).toBe(true); // the ARC completed through the real gateway (both keychain branches assert this)

    // Re-granted: the agent can act again (no longer not_holder).
    await sleep(300);
    const resumed = body(await proxy.callTool('studio_act', { action: 'navigate', url: loopbackUrl + 'home' }));
    expect(resumed.error_reason).not.toBe('not_holder');

    // Encryption-at-rest: the origin-scoped profile blob (if a keychain was available to hold its KEK).
    await sleep(500); // onComplete persists (awaited) before the finally re-grant; allow the file write to settle
    const encPath = join(dataDir, 'studio', 'profiles', `${createHash('sha256').update(loopbackOrigin).digest('hex')}.enc`);
    if (existsSync(encPath)) {
      // keychain branch — the KEK was stored; the blob must NOT contain the cookie cleartext.
      const raw = readFileSync(encPath, 'utf8');
      expect(raw).not.toContain(secret);
      // eslint-disable-next-line no-console
      console.log('[P5 e2e] keychain branch — asserted encrypted persist (no cleartext in .enc)');
    } else {
      // no-keychain branch — ProfileStore.set fail-closed (nothing written); the arc still completed above.
      // eslint-disable-next-line no-console
      console.log('[P5 e2e] no-keychain branch — persist fail-closed (no .enc written); arc completed + re-granted');
    }
  });
});
