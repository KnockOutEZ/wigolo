import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { resetConfig } from '../../../src/config.js';
import type { startStudioHost as StartStudioHost } from '../../../src/cli/studio.js';

/**
 * The Phase-7f DoD end-to-end smoke — the integration the jsdom component lane CANNOT reach. It boots the REAL
 * Studio host (real browser launcher → real CDP screencast) AND loads the REAL built web app in a REAL browser
 * page, then exercises the full loop the unit + component tests can only stub at their seams:
 *   host start → daemon endpoint → nonce→bearer handshake (in the served page) → WS upgrade (bearer subprotocol)
 *   → a frame PAINTS to the canvas → a human input ROUND-TRIPS to the real session page → a server-authoritative
 *   rail update (a control flip) LANDS in the rail DOM.
 *
 * Gated by RUN_STUDIO_HEADED (skips by default) — it launches two browsers, so a display-less CI stays green.
 * Runs the session browser headless (WIGOLO_STUDIO_HEADLESS=1). NOT in gate:studio; it lives in the spawn-serial
 * lane and is required-GREEN only at the phase seal (run via `npm run test:studio:e2e`).
 *
 * HALT CLAUSE: if this surfaces a real WS/bootstrap/server-wiring bug (the 7b-1-bug class), it must FAIL loudly
 * — never weaken an assertion to go green. A red here is a finding to adjudicate, not a test to soften.
 */
const RUN = !!process.env.RUN_STUDIO_HEADED;

// The served web app is built into dist/webapp; the daemon serves it at GET /. Resolve relative to this file
// (… /tests/e2e/studio → repo root). If it has not been built, the smoke cannot run meaningfully.
const WEBAPP_BUILT = existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'webapp', 'app.js'));

describe.skipIf(!RUN || !WEBAPP_BUILT)('studio DoD end-to-end smoke (real host + real browser-loaded web app)', () => {
  let tmp: string;
  let host: Awaited<ReturnType<typeof StartStudioHost>>;
  let viewer: Browser;
  let page: Page;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'wigolo-studio-e2e-'));
    process.env.WIGOLO_CONFIG_PATH = join(tmp, 'config.json');
    process.env.WIGOLO_STUDIO_HEADLESS = '1';
    resetConfig();
    const { startStudioHost } = await import('../../../src/cli/studio.js');
    host = await startStudioHost({ port: 0, host: '127.0.0.1', allowRemote: false, dataDir: tmp });
    viewer = await chromium.launch({ headless: true });
    page = await viewer.newPage();
  }, 60_000);

  afterAll(async () => {
    await page?.close().catch(() => {});
    await viewer?.close().catch(() => {});
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

  it('boots, hands the web app a nonce→bearer, paints a frame, round-trips human input, and lands a server-authoritative rail update', async () => {
    // A full-screen input on an animated background: the animation forces repaints (→ frames flow), and the
    // input is the round-trip target for forwarded human keystrokes.
    const html =
      '<style>@keyframes b{0%{background:#003}50%{background:#0a0}100%{background:#003}}' +
      'html,body{margin:0;height:100%;animation:b .3s infinite}' +
      '#f{position:fixed;inset:0;width:100%;height:100%;font-size:48px;background:transparent}</style>' +
      '<input id="f" autofocus />';
    await host.sessionBrowser.navigate('data:text/html,' + encodeURIComponent(html));

    // Load the REAL served web app with the one-time nonce in the URL (never the bearer). The page redeems it
    // for the bearer over loopback, then opens the authenticated WS — all in the real bundle.
    await page.goto(host.webappUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas.studio-canvas', { timeout: 10_000 });

    // (1) A frame PAINTED to the canvas — the handshake + WS upgrade + screencast decode all worked end-to-end.
    // A blank canvas is fully zeroed; a painted frame turns pixels opaque (alpha=255), so some byte is non-zero.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const c = document.querySelector('canvas.studio-canvas') as HTMLCanvasElement | null;
            const ctx = c?.getContext('2d');
            if (!c || !ctx) return false;
            const data = ctx.getImageData(0, 0, c.width, c.height).data;
            for (let i = 0; i < data.length; i++) if (data[i] !== 0) return true;
            return false;
          }),
        { timeout: 15_000, interval: 200 },
      )
      .toBe(true);

    // (2) Human input ROUND-TRIPS through the web app to the real session page. The human holds control on boot
    // (epoch 0), so a click (focus) + keystrokes forwarded by the bundle land in the real <input>.
    await page.locator('canvas.studio-canvas').click({ position: { x: 200, y: 200 } });
    await page.keyboard.type('hi');
    const fieldValue = () =>
      (host.sessionBrowser.page as unknown as Page).evaluate(() => (document.getElementById('f') as HTMLInputElement).value);
    await expect.poll(fieldValue, { timeout: 10_000 }).toBe('hi');

    // (3) A SERVER-authoritative rail update lands: the host flips control to the agent → the {t:'control'}
    // broadcast drives the web app's ControlsModel → the who's-driving indicator reflects it (never optimistic).
    host.controller.handleControl({ op: 'grant', to: 'agent' });
    await expect
      .poll(() => page.evaluate(() => document.querySelector('.studio-driving')?.getAttribute('data-holder')), { timeout: 10_000 })
      .toBe('agent');

    host.controller.handleControl({ op: 'reclaim' });
  }, 90_000);
});
