import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { resetConfig } from '../../src/config.js';
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
});
