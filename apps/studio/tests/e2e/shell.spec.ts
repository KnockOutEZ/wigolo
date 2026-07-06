import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');
const FIXTURE = pathToFileURL(join(import.meta.dirname, 'fixtures/spike.html')).href;

describe('studio shell', () => {
  let app: ElectronApplication;
  let chrome: Page;

  beforeAll(async () => {
    app = await electron.launch({ args: [APP_MAIN] });
    chrome = await app.firstWindow();
    await chrome.waitForSelector('[data-testid="new-tab"]');
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots with the chrome renderer and no tabs', async () => {
    expect(await chrome.locator('[data-testid^="tab-"]').count()).toBe(0);
  });

  it('omnibox Enter creates a live WebContentsView tab that really renders the page', async () => {
    await chrome.fill('[data-testid="omnibox"]', FIXTURE);
    await chrome.press('[data-testid="omnibox"]', 'Enter');
    await chrome.waitForSelector('[data-testid^="tab-"]');
    // the fixture page is a real, separate web contents — poll, don't waitForEvent (it may already have fired)
    await expect
      .poll(() => app.windows().some((p) => p.url() === FIXTURE), { timeout: 15_000 })
      .toBe(true);
    const fixturePage = app.windows().find((p) => p.url() === FIXTURE) as Page;
    expect(await fixturePage.textContent('#heading')).toBe('Spike Fixture');
  });

  it('new-tab + close-tab round trip keeps exactly one active tab', async () => {
    await chrome.click('[data-testid="new-tab"]');
    const tabs = chrome.locator('[data-testid^="tab-"]');
    await expect.poll(() => tabs.count()).toBe(2);
    const secondId = (await tabs.nth(1).getAttribute('data-testid'))!.replace('tab-', '');
    await chrome.click(`[data-testid="close-${secondId}"]`);
    await expect.poll(() => tabs.count()).toBe(1);
  });
});
