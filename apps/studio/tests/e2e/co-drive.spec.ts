import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ElectronApplication } from 'playwright';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { launchStudio } from './launch';
import { readHandle, DaemonProxy } from 'wigolo/studio';
import { IPC } from '../../src/shared/ipc';

// GATED (RUN_STUDIO_E2E) — the P4 co-drive loop end-to-end through the REAL embedded gateway + drive engine.
// Observables are chosen for the CLOSED-shadow overlay: the ghost cursor draws inside a closed shadow root
// an e2e cannot read, so we assert (a) the main-process overlayCursor IPC fired with the resolved centre +
// caption, and (b) the chrome renderer received the driveEvent with the agent narration. Pause is the real
// renderer→main reclaim; the grant is asserted at the act/nav layer against a real loopback fixture server.
const RUN = !!process.env.RUN_STUDIO_E2E;
const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');

interface ToolResult { content: Array<{ type: string; text: string }>; isError: boolean }
const body = (r: unknown) => JSON.parse((r as ToolResult).content[0].text) as Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A marked, non-risky, uniquely-identifiable button so heal → a high-confidence ref the agent can click.
const faqPayload = { tag: 'button', id: 'faq', classes: [], attrs: { 'data-testid': 'faq-btn' }, dataset: { testid: 'faq-btn' }, text: 'Open FAQ', component: null, source: null };
const INJECT = "document.body.innerHTML = '<button id=\\'faq\\' data-testid=\\'faq-btn\\'>Open FAQ</button>'; true";

describe.skipIf(!RUN)('studio co-drive polish (e2e, real gateway)', () => {
  let app: ElectronApplication;
  let dataDir: string;
  let endpoint: string;
  let token: string;
  let loopback: Server;
  let loopbackUrl: string;

  beforeAll(async () => {
    loopback = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>local</title><h1>local dev</h1>'); });
    await new Promise<void>((r) => loopback.listen(0, '127.0.0.1', r));
    const addr = loopback.address();
    loopbackUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/` : 'http://127.0.0.1:0/';
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-studio-codrive-e2e-'));
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

  // Close any live sessions so each test starts with EXACTLY the one session tab it opens — otherwise
  // st.tabs[0] (the reclaim target) can be a stale prior session's tab, not the one the agent is driving.
  async function resetSessions(proxy: DaemonProxy): Promise<void> {
    const list = body(await proxy.callTool('studio_list', {}));
    for (const s of (list.sessions as Array<{ id: string }>) ?? []) await proxy.callTool('studio_close', { session_id: s.id });
    await sleep(200);
  }

  // Inject the fixture DOM + mark #faq via the REAL overlay→main IPC (no nav → fence untouched); return the ref.
  async function markFaq(proxy: DaemonProxy): Promise<string> {
    const injected = await app.evaluate(async ({ webContents, ipcMain }, arg) => {
      const wc = webContents.getAllWebContents().find((w) => { const u = w.getURL(); return u === '' || u === 'about:blank'; });
      if (!wc) return false;
      await wc.executeJavaScript(arg.inject);
      const path: number[] = await wc.executeJavaScript(
        `(function(el){var p=[],cur=el,root=document.documentElement;while(cur&&root&&cur!==root){var parent=cur.parentElement;if(!parent)break;var i=Array.prototype.indexOf.call(parent.children,cur);if(i<0)break;p.unshift(i);cur=parent;}return el?p:null;})(document.querySelector('#faq'))`,
      );
      ipcMain.emit(arg.channel, { sender: wc }, { nonce: 'faq', path, payload: arg.faqPayload });
      return true;
    }, { inject: INJECT, channel: IPC.overlayMark, faqPayload });
    expect(injected).toBe(true);
    let ref: string | undefined;
    for (let i = 0; i < 40 && !ref; i++) {
      await sleep(150);
      const v = body(await proxy.callTool('studio_marks', {}));
      ref = ((v.marks as Array<Record<string, unknown>>) ?? []).find((m) => m.name === 'Open FAQ')?.ref as string | undefined;
    }
    if (!ref) throw new Error('FAQ mark never resolved to a ref');
    return ref;
  }

  it('agent click narrates → ghost-cursor IPC fires at the resolved centre + the chrome renderer gets the driveEvent', async () => {
    const proxy = new DaemonProxy(endpoint, token);
    await resetSessions(proxy);
    await proxy.callTool('studio_open', {});
    const ref = await markFaq(proxy);

    // Spy the session-tab overlayCursor sends (main) + the chrome renderer driveEvents (renderer).
    await app.evaluate(({ webContents }, ch) => {
      const g = globalThis as unknown as { __cursor: Array<{ x: number; y: number; caption: string }> };
      g.__cursor = [];
      const wc = webContents.getAllWebContents().find((w) => { const u = w.getURL(); return u === '' || u === 'about:blank'; });
      if (wc) { const orig = wc.send.bind(wc); wc.send = (channel: string, ...a: unknown[]) => { if (channel === ch) g.__cursor.push(a[0] as { x: number; y: number; caption: string }); return orig(channel, ...a); }; }
    }, IPC.overlayCursor);
    const win = await app.firstWindow();
    await win.evaluate(() => { (window as unknown as { __drive: unknown[] }).__drive = []; (window as unknown as { studio: { onDriveEvent(cb: (e: unknown) => void): void } }).studio.onDriveEvent((e) => (window as unknown as { __drive: unknown[] }).__drive.push(e)); });

    body(await proxy.callTool('studio_act', { action: 'click', ref, narration: 'opening FAQ' }));

    let cursor: Array<{ caption: string }> = [];
    for (let i = 0; i < 40 && cursor.length === 0; i++) { await sleep(150); cursor = await app.evaluate(() => (globalThis as unknown as { __cursor: Array<{ caption: string }> }).__cursor); }
    expect(cursor.some((c) => c.caption === 'opening FAQ')).toBe(true); // ghost cursor drew at the resolved point

    const drive = await win.evaluate(() => (window as unknown as { __drive: Array<{ t: string; narration?: string; action?: string }> }).__drive);
    expect(drive.some((e) => e.t === 'act' && e.action === 'click' && e.narration === 'opening FAQ')).toBe(true);
  });

  it('Pause (renderer reclaim) preempts the agent — the next act is refused not_holder', async () => {
    const proxy = new DaemonProxy(endpoint, token);
    await resetSessions(proxy);
    await proxy.callTool('studio_open', {});
    const ref = await markFaq(proxy);
    // Agent holds its own session → a click lands (no error_reason).
    const first = body(await proxy.callTool('studio_act', { action: 'click', ref }));
    expect(first.error_reason).toBeUndefined();
    // Human hits Pause via the REAL renderer seam (reclaimDrive on the session tab id) → token flips to human.
    const win = await app.firstWindow();
    await win.evaluate(async () => {
      const studio = (window as unknown as { studio: { getState(): Promise<{ tabs: Array<{ id: string }> }>; reclaimDrive(id: string): Promise<void> } }).studio;
      const st = await studio.getState();
      await studio.reclaimDrive(st.tabs[0].id);
    });
    await sleep(300);
    const after = body(await proxy.callTool('studio_act', { action: 'click', ref }));
    expect(after.error_reason).toBe('not_holder'); // the agent no longer holds — preempted
  });

  it('studio_say posts the agent message to the chat rail', async () => {
    const proxy = new DaemonProxy(endpoint, token);
    await resetSessions(proxy);
    await proxy.callTool('studio_open', {});
    const win = await app.firstWindow();
    await win.evaluate(() => { (window as unknown as { __chat: unknown[] }).__chat = []; (window as unknown as { studio: { onChatMessage(cb: (m: unknown) => void): void } }).studio.onChatMessage((m) => (window as unknown as { __chat: unknown[] }).__chat.push(m)); });
    const said = body(await proxy.callTool('studio_say', { text: 'I found the pricing table' }));
    expect(said.posted).toBe(true);
    let chat: Array<{ author: string; text: string }> = [];
    for (let i = 0; i < 40 && chat.length === 0; i++) { await sleep(150); chat = await win.evaluate(() => (window as unknown as { __chat: Array<{ author: string; text: string }> }).__chat); }
    expect(chat.some((m) => m.author === 'agent' && m.text === 'I found the pricing table')).toBe(true);
  });

  it('localhost grant flips the agent nav: blocked → allowed; cloud-metadata stays blocked', async () => {
    const proxy = new DaemonProxy(endpoint, token);
    await resetSessions(proxy);
    await proxy.callTool('studio_open', {});
    // Pre-grant: the agent cannot navigate to loopback.
    const before = body(await proxy.callTool('studio_act', { action: 'navigate', url: loopbackUrl }));
    expect(before.error_reason).toBe('navigation_blocked');
    // Human grants localhost for the session (the real renderer seam).
    const win = await app.firstWindow();
    await win.evaluate(() => (window as unknown as { studio: { grantLocalhost(): Promise<boolean> } }).studio.grantLocalhost());
    await sleep(200);
    // Post-grant: the SAME loopback nav now succeeds (served by the fixture server).
    const after = body(await proxy.callTool('studio_act', { action: 'navigate', url: loopbackUrl }));
    expect(after.ok).toBe(true);
    // But cloud-metadata is NEVER grantable — still blocked after the grant.
    const meta = body(await proxy.callTool('studio_act', { action: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' }));
    expect(meta.error_reason).toBe('navigation_blocked');
  });
});
