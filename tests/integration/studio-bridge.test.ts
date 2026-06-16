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
});
