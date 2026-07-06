import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron, chromium, type ElectronApplication, type Browser } from 'playwright';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type AddressInfo } from 'node:net';

const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');
const FIXTURE = pathToFileURL(join(import.meta.dirname, 'fixtures/spike.html')).href;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe('SPIKE: connectOverCDP drives a studio tab', () => {
  let app: ElectronApplication;
  let cdp: Browser;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    app = await electron.launch({
      args: [APP_MAIN],
      env: { ...process.env, WIGOLO_STUDIO_CDP_PORT: String(port) },
    });
    const chrome = await app.firstWindow();
    await chrome.fill('[data-testid="omnibox"]', FIXTURE);
    await chrome.press('[data-testid="omnibox"]', 'Enter');
    // poll, not waitForEvent — the window event may fire before we subscribe
    const deadline = Date.now() + 15_000;
    while (!app.windows().some((p) => p.url() === FIXTURE)) {
      if (Date.now() > deadline) throw new Error('fixture tab never appeared');
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  afterAll(async () => {
    await cdp?.close();
    await app.close();
  });

  it('GO-1: an external Playwright can attach over CDP', async () => {
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    expect(cdp.contexts().length).toBeGreaterThan(0);
  });

  it('GO-2: the tab WebContentsView is visible as a CDP page target', async () => {
    const pages = cdp.contexts().flatMap((c) => c.pages());
    const tab = pages.find((p) => p.url() === FIXTURE);
    expect(tab, `targets seen: ${pages.map((p) => p.url()).join(', ')}`).toBeTruthy();
  });

  it('GO-3: click, type, and evaluate all work through the attached session', async () => {
    const tab = cdp.contexts().flatMap((c) => c.pages()).find((p) => p.url() === FIXTURE)!;
    await tab.click('#btn');
    await tab.click('#btn');
    expect(await tab.textContent('#count')).toBe('2');
    await tab.fill('#field', 'driven by agent');
    expect(await tab.inputValue('#field')).toBe('driven by agent');
    expect(await tab.evaluate(() => document.title)).toBe('Spike Fixture');
  });

  it('GO-4: a tab opened AFTER attach appears as a new target', async () => {
    const chrome = await app.firstWindow();
    await chrome.click('[data-testid="new-tab"]');
    await expect
      .poll(() => cdp.contexts().flatMap((c) => c.pages()).some((p) => p.url() === 'about:blank'), { timeout: 10_000 })
      .toBe(true);
  });
});
