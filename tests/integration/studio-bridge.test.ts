import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { resetConfig } from '../../src/config.js';
import { navigateSession } from '../../src/studio/nav.js';
import type { startStudioHost as StartStudioHost } from '../../src/cli/studio.js';

/**
 * End-to-end screencast over a REAL browser: boots the Studio host (real
 * Playwright launcher → real CDP), navigates to an animated page, connects an
 * authenticated WebSocket, and asserts frames stream with the ack loop running.
 * Also the only automated coverage of `defaultSessionLauncher`.
 *
 * Gated by RUN_STUDIO_HEADED (skips by default) — it launches a browser, so CI
 * without one stays green. Runs headless (WIGOLO_STUDIO_HEADLESS=1) so it needs
 * no display; the latency spike confirmed headless ≈ headed for screencast.
 */
const RUN = !!process.env.RUN_STUDIO_HEADED;

describe.skipIf(!RUN)('studio screencast bridge (integration, real browser)', () => {
  let tmp: string;
  let host: Awaited<ReturnType<typeof StartStudioHost>>;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'wigolo-studio-int-'));
    process.env.WIGOLO_CONFIG_PATH = join(tmp, 'config.json');
    process.env.WIGOLO_STUDIO_HEADLESS = '1';
    resetConfig();
    const { startStudioHost } = await import('../../src/cli/studio.js');
    host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, dataDir: tmp });
  }, 60_000);

  afterAll(async () => {
    if (host) {
      host.hub.closeAll();
      await host.bridge.stop().catch(() => {});
      await host.sessionBrowser.close().catch(() => {});
      await host.daemon.stop().catch(() => {});
    }
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.WIGOLO_STUDIO_HEADLESS;
    resetConfig();
  });

  it('streams screencast frames over the websocket to an authenticated client', async () => {
    // A CSS animation forces continuous repaints → the (repaint-driven) screencast emits frames.
    const html =
      '<style>@keyframes b{0%{background:#000}50%{background:#f00}100%{background:#000}}' +
      'body{margin:0;height:100vh;animation:b .3s infinite}</style><body></body>';
    await host.sessionBrowser.navigate('data:text/html,' + encodeURIComponent(html));

    const wsUrl = host.endpoint.replace('http://', 'ws://') + `/studio/${host.session.id}/stream`;
    const ws = new WebSocket(wsUrl, ['wigolo.stream', `wigolo.bearer.${host.session.token}`]);

    let frames = 0;
    ws.on('message', (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString());
      if (m.t === 'frame') {
        frames++;
        ws.send(JSON.stringify({ t: 'ack' })); // drive the ack loop so the next frame forwards
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    await new Promise((r) => setTimeout(r, 2500)); // collect for a budget
    ws.close();

    expect(frames).toBeGreaterThanOrEqual(3); // ack-paced frames actually flowed end-to-end
  }, 30_000);

  it('rejects a websocket without the bearer subprotocol (auth enforced on upgrade)', async () => {
    const wsUrl = host.endpoint.replace('http://', 'ws://') + `/studio/${host.session.id}/stream`;
    const ws = new WebSocket(wsUrl, ['wigolo.stream']); // no bearer
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      }),
    ).rejects.toBeDefined();
  }, 15_000);

  it('forwards human input to the real page and enforces token semantics (only the holder lands; a flip drops input)', async () => {
    const html =
      '<input id="f" autofocus style="position:fixed;inset:0;width:100%;height:100%;font-size:40px" />' +
      '<script>window.__clicks=0;document.addEventListener("pointerdown",function(){window.__clicks++});</script>';
    await host.sessionBrowser.navigate('data:text/html,' + encodeURIComponent(html));
    const page = host.sessionBrowser.page as unknown as import('playwright').Page;
    const fieldValue = () => page.evaluate(() => (document.getElementById('f') as HTMLInputElement).value);

    const wsUrl = host.endpoint.replace('http://', 'ws://') + `/studio/${host.session.id}/stream`;
    const ws = new WebSocket(wsUrl, ['wigolo.stream', `wigolo.bearer.${host.session.token}`]);
    await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
    const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));

    // Human holds at epoch 0. Click to focus the full-screen input (also proves click forwarding), then type "hi".
    send({ t: 'input', kind: 'mouse', epoch: 0, type: 'mousePressed', nx: 0.5, ny: 0.5, button: 'left' });
    send({ t: 'input', kind: 'mouse', epoch: 0, type: 'mouseReleased', nx: 0.5, ny: 0.5, button: 'left' });
    for (const [key, code] of [['h', 'KeyH'], ['i', 'KeyI']]) {
      send({ t: 'input', kind: 'key', epoch: 0, type: 'keyDown', key, code, text: key });
      send({ t: 'input', kind: 'key', epoch: 0, type: 'keyUp', key, code });
    }
    await expect.poll(fieldValue, { timeout: 5000 }).toBe('hi');
    expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBeGreaterThanOrEqual(1);

    // Hand control to the agent → the human (WS) party is no longer the holder, so its input must be dropped.
    send({ t: 'control', op: 'grant', to: 'agent' });
    await new Promise((r) => setTimeout(r, 150));
    send({ t: 'input', kind: 'key', epoch: 1, type: 'keyDown', key: 'X', code: 'KeyX', text: 'X' });
    await new Promise((r) => setTimeout(r, 200));
    expect(await fieldValue()).toBe('hi'); // 'X' dropped — agent holds the token

    // Human reclaims (epoch now 2) → input lands again.
    send({ t: 'control', op: 'reclaim' });
    await new Promise((r) => setTimeout(r, 150));
    send({ t: 'input', kind: 'key', epoch: 2, type: 'keyDown', key: 'z', code: 'KeyZ', text: 'z' });
    send({ t: 'input', kind: 'key', epoch: 2, type: 'keyUp', key: 'z', code: 'KeyZ' });
    await expect.poll(fieldValue, { timeout: 5000 }).toBe('hiz');

    ws.close();
  }, 30_000);

  it('releases held input when a client disconnects mid-drag (no stranded button on the page)', async () => {
    const html =
      '<body style="margin:0;height:100vh"><script>window.__ups=0;document.addEventListener("mouseup",function(){window.__ups++});</script></body>';
    await host.sessionBrowser.navigate('data:text/html,' + encodeURIComponent(html));
    const page = host.sessionBrowser.page as unknown as import('playwright').Page;

    const wsUrl = host.endpoint.replace('http://', 'ws://') + `/studio/${host.session.id}/stream`;
    const ws = new WebSocket(wsUrl, ['wigolo.stream', `wigolo.bearer.${host.session.token}`]);
    // hello carries the current {holder, epoch} so we can stamp valid input.
    const hello = await new Promise<{ epoch: number }>((resolve, reject) => {
      ws.on('message', (d: WebSocket.RawData) => resolve(JSON.parse(d.toString())));
      ws.on('error', reject);
    });

    // Press a button and DROP the connection WITHOUT releasing it (a mid-drag disconnect).
    ws.send(JSON.stringify({ t: 'input', kind: 'mouse', epoch: hello.epoch, type: 'mousePressed', nx: 0.5, ny: 0.5, button: 'left' }));
    await new Promise((r) => setTimeout(r, 150));
    ws.close();

    // The host reaps the gone client and synthesizes the release → a mouseup fires on the page.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ups: number }).__ups), { timeout: 5000 }).toBe(1);
  }, 30_000);

  it('source-aware SSRF nav over a real browser: human reaches localhost (incl. via a redirect hop), agent is blocked, metadata is blocked for both', async () => {
    // Local redirect server. (A real public→metadata redirect can't be hermetic;
    // the per-hop re-validation of a blocked redirect target is proven deterministically
    // in tests/unit/studio/nav.test.ts. Here we prove redirect targets are re-paused +
    // continued when allowed, and the source asymmetry, against a real browser.)
    const server = createServer((req, res) => {
      if (req.url === '/dest') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<body>DEST</body>');
      } else if (req.url === '/redir') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/dest` });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    );
    const base = `http://127.0.0.1:${port}`;
    const page = host.sessionBrowser.page as unknown as import('playwright').Page;
    const human = { source: 'human' as const, allowPrivate: true };
    const agent = { source: 'agent' as const, allowPrivate: false };

    try {
      // The interceptor now PULLS the live control-token holder per hop (2C), so drive
      // the policy via the token, not the removed setPolicy: human holds → human policy.
      host.controller.handleControl({ op: 'reclaim' });
      // 1. human → 302 → localhost ALLOWED: the redirect target is re-paused AND continued.
      const r1 = await navigateSession(host.sessionBrowser, `${base}/redir`, human);
      expect(r1.ok).toBe(true);
      expect(await page.evaluate(() => document.body.textContent)).toContain('DEST');

      // 2. agent → localhost BLOCKED (source asymmetry; the localhost hop is guarded for the agent).
      host.controller.handleControl({ op: 'grant', to: 'agent' }); // holder=agent → interceptor uses agent policy
      expect((await navigateSession(host.sessionBrowser, `${base}/redir`, agent)).ok).toBe(false);

      // 3. metadata blocked for BOTH parties (always; link-local).
      expect((await navigateSession(host.sessionBrowser, 'http://169.254.169.254/', human)).ok).toBe(false);
      expect((await navigateSession(host.sessionBrowser, 'http://169.254.169.254/', agent)).ok).toBe(false);
    } finally {
      host.controller.handleControl({ op: 'reclaim' });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('a human reclaim DURING an agent navigation aborts it — the page does not land on the agent target (in-flight abort)', async () => {
    // The deferred 2C proof, now that the agent nav path (studio_act) exists. A slow
    // endpoint keeps the nav genuinely in-flight; the human reclaims mid-load → the
    // onChange→abortInFlight (Page.stopLoading) cancels it, so the page never reaches
    // the agent's target. (The gate→start window is closed deterministically by the
    // epoch fence — proven in the unit suite — so this exercises the in-flight half.)
    const server = createServer((req, res) => {
      if (req.url === '/slow') {
        setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<body>AGENT_TARGET</body>'); }, 4000);
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<body>HUMAN_START</body>');
      }
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    );
    const base = `http://127.0.0.1:${port}`;
    const page = host.sessionBrowser.page as unknown as import('playwright').Page;

    try {
      // Human lands on a known start page.
      host.controller.handleControl({ op: 'reclaim' });
      await navigateSession(host.sessionBrowser, `${base}/start`, { source: 'human', allowPrivate: true });
      expect(await page.evaluate(() => document.body.textContent)).toContain('HUMAN_START');

      // Hand control to the agent (+grant localhost so the slow nav isn't blocked at entry),
      // start a slow agent nav, let it get in-flight, then the human reclaims mid-load.
      host.controller.handleControl({ op: 'grant', to: 'agent' });
      host.grantAgentPrivateNav(true);
      const navP = host.act({ action: 'navigate', url: `${base}/slow` });
      await new Promise((r) => setTimeout(r, 500)); // nav is now in-flight (target is 4s slow)
      host.controller.handleControl({ op: 'reclaim' }); // human takeover → abortInFlight (Page.stopLoading)
      await navP.catch(() => {});

      // The agent's nav was aborted — the page never reached the agent's target.
      await new Promise((r) => setTimeout(r, 500));
      expect(await page.evaluate(() => document.body.textContent)).not.toContain('AGENT_TARGET');
    } finally {
      host.controller.handleControl({ op: 'reclaim' });
      host.grantAgentPrivateNav(false);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  // ───────────────────────────── 2J.2 abort-layer safety proofs ─────────────────────────────
  // The agent's click/type/scroll dispatch through the SAME token-gated CDP input channel the
  // human uses (SessionController → InputForwarder), stamped party='agent' at the gate epoch.
  // These five run against a real browser; the safety assertions are hard (no retry masks them —
  // a poll only waits for an async input/neutralize to land, then the hard assert decides).

  const INPUT_HTML =
    '<input id="f" autofocus style="position:fixed;inset:0;width:100%;height:100%;font-size:40px" />';
  const fieldOf = () =>
    (host.sessionBrowser.page as unknown as import('playwright').Page).evaluate(
      () => (document.getElementById('f') as HTMLInputElement).value,
    );

  it('2J.2 (1) the epoch fence DROPS a unit dispatched with a STALE epoch after a reclaim (strong: not merely "skip the next keystroke")', async () => {
    await host.sessionBrowser.navigate('data:text/html,' + encodeURIComponent(INPUT_HTML));

    host.controller.handleControl({ op: 'grant', to: 'agent' });
    const staleEpoch = host.controller.controlSnapshot().epoch; // the epoch the agent's units are stamped with
    host.controller.handleControl({ op: 'reclaim' }); // human takeover → the live epoch advances; staleEpoch is revoked

    // Dispatch a full keystroke unit STAMPED WITH THE STALE EPOCH (the strong version: an actual
    // dispatch with the old epoch, not a loop that skips). The fence must drop the whole unit.
    const landed = await host.controller.dispatchAgentUnit(staleEpoch, [
      { kind: 'key', type: 'keyDown', key: 'Z', code: 'KeyZ' },
      { kind: 'key', type: 'char', key: 'Z', text: 'Z' },
      { kind: 'key', type: 'keyUp', key: 'Z', code: 'KeyZ' },
    ]);

    expect(landed).toBe(false); // dropped by the fence
    await new Promise((r) => setTimeout(r, 150));
    expect(await fieldOf()).toBe(''); // and NOT ONE character reached the page
    host.controller.handleControl({ op: 'reclaim' });
  }, 30_000);

  it('2J.2 (2) a modifier the agent left held is RELEASED on reclaim — the page receives the synthesized Shift keyup (no stuck modifier)', async () => {
    // Page counts real Shift down/up events. The agent presses Shift (a sequence interrupted right
    // after the modifier went down — the danger case the neutralize net exists for); the reclaim's
    // onChange→neutralizeHeld must synthesize the matching Shift keyUP on the page.
    const html =
      '<body><script>window.__sd=0;window.__su=0;' +
      'addEventListener("keydown",function(e){if(e.key==="Shift")window.__sd++});' +
      'addEventListener("keyup",function(e){if(e.key==="Shift")window.__su++});</script></body>';
    await host.sessionBrowser.navigate('data:text/html,' + encodeURIComponent(html));
    const page = host.sessionBrowser.page as unknown as import('playwright').Page;

    host.controller.handleControl({ op: 'grant', to: 'agent' });
    const e = host.controller.controlSnapshot().epoch;
    await host.controller.dispatchAgentUnit(e, [{ kind: 'key', type: 'keyDown', key: 'Shift', code: 'ShiftLeft' }]);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sd: number }).__sd), { timeout: 5000 }).toBe(1);

    host.controller.handleControl({ op: 'reclaim' }); // flip → neutralizeHeld releases the agent's held Shift on the page
    // HARD safety claim: the page saw the Shift keyup — the held modifier was released, not stranded.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __su: number }).__su), { timeout: 5000 }).toBe(1);
  }, 30_000);

  it('2J.2 (3) ≤1-in-flight: after a reclaim the one already-committed unit has landed and nothing after it does', async () => {
    await host.sessionBrowser.navigate('data:text/html,' + encodeURIComponent(INPUT_HTML));

    host.controller.handleControl({ op: 'grant', to: 'agent' });
    const e = host.controller.controlSnapshot().epoch;

    // Commit unit 'a' at the live epoch — it lands.
    expect(
      await host.controller.dispatchAgentUnit(e, [
        { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA' },
        { kind: 'key', type: 'char', key: 'a', text: 'a' },
        { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA' },
      ]),
    ).toBe(true);
    await expect.poll(fieldOf, { timeout: 5000 }).toBe('a');

    host.controller.handleControl({ op: 'reclaim' }); // epoch advances

    // The NEXT unit (stale epoch) is dropped — nothing lands after the committed one.
    expect(
      await host.controller.dispatchAgentUnit(e, [
        { kind: 'key', type: 'keyDown', key: 'b', code: 'KeyB' },
        { kind: 'key', type: 'char', key: 'b', text: 'b' },
        { kind: 'key', type: 'keyUp', key: 'b', code: 'KeyB' },
      ]),
    ).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(await fieldOf()).toBe('a'); // exactly the committed unit; 'b' never landed
    host.controller.handleControl({ op: 'reclaim' });
  }, 30_000);

  it('2J.2 (4) an overlay that appears BETWEEN observe and act makes the click resolve to element_occluded (vision trigger)', async () => {
    const html =
      '<button id="b" style="position:fixed;left:40px;top:40px;width:200px;height:60px">Go</button>' +
      '<div id="ov" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999"></div>';
    await host.sessionBrowser.navigate('data:text/html,' + encodeURIComponent(html));
    const page = host.sessionBrowser.page as unknown as import('playwright').Page;

    host.controller.handleControl({ op: 'grant', to: 'agent' });

    // Observe with no overlay → get the button's live ref.
    const obs = (await host.observe({})) as { elements?: Array<{ ref: string; role: string; name: string }>; error_reason?: string };
    expect(obs.error_reason, 'observe should not refuse').toBeUndefined();
    const btn = (obs.elements ?? []).find((el) => el.role === 'button');
    expect(btn, 'observe should surface the button').toBeTruthy();

    // The overlay appears AFTER observe, BEFORE the act resolves the ref live.
    await page.evaluate(() => {
      (document.getElementById('ov') as HTMLElement).style.display = 'block';
    });

    const r = (await host.act({ action: 'click', ref: btn!.ref })) as { error_reason?: string };
    expect(r.error_reason).toBe('element_occluded'); // hit-test caught the overlay on top of the resolved node
    host.controller.handleControl({ op: 'reclaim' });
  }, 30_000);

  it('2J.2 (5) a reclaim mid-type aborts with aborted_reclaimed and HONESTLY reports the characters that landed', async () => {
    await host.sessionBrowser.navigate('data:text/html,' + encodeURIComponent(INPUT_HTML));

    host.controller.handleControl({ op: 'grant', to: 'agent' });
    const obs = (await host.observe({})) as { elements?: Array<{ ref: string; role: string }> };
    const tb = (obs.elements ?? []).find((el) => el.role === 'textbox');
    expect(tb, 'observe should surface the textbox').toBeTruthy();

    // Type a long string; reclaim shortly after so it aborts partway (80 keystroke units cannot
    // all land in the window → the abort is deterministic; the exact landed count is not asserted).
    const text = 'a'.repeat(80);
    const p = host.act({ action: 'type', ref: tb!.ref, text });
    await new Promise((r) => setTimeout(r, 60));
    host.controller.handleControl({ op: 'reclaim' });
    const r = (await p) as { error_reason?: string; charsLanded?: number };

    expect(r.error_reason).toBe('aborted_reclaimed');
    const landed = await fieldOf();
    expect(r.charsLanded).toBe(landed.length); // the report MATCHES the page reality (honest partial effect)
    expect(r.charsLanded!).toBeLessThan(text.length); // it really did abort partway, not finish
    host.controller.handleControl({ op: 'reclaim' });
  }, 30_000);
});
