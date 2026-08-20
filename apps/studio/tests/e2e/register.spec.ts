import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ElectronApplication, type Page } from 'playwright';
import { join } from 'node:path';
import { launchStudio } from './launch';

// GATED (RUN_STUDIO_E2E) — launches the real Electron app, so it runs on the ubuntu CI lane under xvfb.
const RUN = !!process.env.RUN_STUDIO_E2E;
const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');

/**
 * The register claim, made against a real browser engine: both registers come from one layer, the
 * switch is live, and the token values the components resolve really do change.
 *
 * The switch is driven through the renderer's actual input — the system colour-scheme preference —
 * rather than by setting the attribute directly. A test that wrote the attribute itself would prove
 * the attribute works and nothing about whether the app is wired to anything.
 */
describe.skipIf(!RUN)('style registers (e2e, real browser engine)', () => {
  let app: ElectronApplication;
  let chrome: Page;

  const register = (): Promise<string | null> =>
    chrome.evaluate(() => document.documentElement.getAttribute('data-register'));

  const resolved = (name: string): Promise<string> =>
    chrome.evaluate(
      (token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(),
      name,
    );

  const railBackground = (): Promise<string> =>
    chrome.evaluate(() => getComputedStyle(document.querySelector('.rail')!).backgroundColor);

  /**
   * The media-query change and the attribute write it triggers land a frame apart, so this settles
   * rather than asserting immediately. Hand-rolled rather than `expect.poll` because it also runs
   * from `beforeAll`, where poll refuses to work.
   */
  const switchTo = async (source: 'dark' | 'light'): Promise<void> => {
    await chrome.emulateMedia({ colorScheme: source });
    for (let i = 0; i < 100; i++) {
      if ((await register()) === source) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`renderer never adopted the ${source} register`);
  };

  beforeAll(async () => {
    app = await launchStudio({ args: [APP_MAIN] });
    chrome = await app.firstWindow();
    await chrome.waitForSelector('[data-testid="new-tab"]');
    await switchTo('dark');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('resolves the design system tokens in the dark register', async () => {
    expect(await resolved('--bg')).toBe('#000');
    expect(await resolved('--surface-panel')).toBe('#060606');
    expect(await resolved('--agent')).toBe('oklch(0.8 0.06 250)');
  });

  it('resolves the legacy alias bridge through the tokens, so the shipped components inherit both registers', async () => {
    // The 13 components still reference `--surface`, `--text` and friends, and they must land on the
    // layer. Checked as a USED value on a real element as well: a broken alias resolves to nothing,
    // which keeps the layout and silently drops the colour.
    expect(await resolved('--surface')).toBe('#060606');
    expect(await resolved('--text')).toBe('rgba(255,255,255,.95)');
    expect(await railBackground()).toBe('rgb(6, 6, 6)');
  });

  it('re-anchors the whole app when the system register changes, with no reload', async () => {
    // A marker on the window object survives a repaint and does not survive a reload or a remount,
    // so it is the difference between "the app restyled" and "the app reloaded looking restyled".
    await chrome.evaluate(() => {
      (window as unknown as { registerProbe: string }).registerProbe = 'alive';
    });
    const darkRail = await railBackground();

    await switchTo('light');

    expect(await resolved('--bg')).toBe('#f6f5f2');
    expect(await resolved('--agent')).toBe('oklch(0.5 0.13 250)');
    // The light register keeps terminals dark on purpose (§11) — proof the switch is a token swap
    // and not a global inversion.
    expect(await resolved('--surface-term')).toBe('#16171b');
    expect(await railBackground()).not.toBe(darkRail);
    expect(
      await chrome.evaluate(() => (window as unknown as { registerProbe?: string }).registerProbe),
    ).toBe('alive');
  });

  it('switches back, and the chrome is still interactive afterwards', async () => {
    await switchTo('dark');
    expect(await resolved('--bg')).toBe('#000');
    // Repeated switching must not leave a detached layer behind.
    expect(await chrome.locator('#wigolo-tokens').count()).toBe(1);
    await chrome.click('[data-testid="new-tab"]');
    await expect.poll(() => chrome.locator('[data-testid^="tab-"]').count()).toBe(1);
  });

  it('never resolves a token to nothing', async () => {
    // A custom property that fails to resolve is invisible: the component keeps its layout and
    // silently loses its colour. Every token is checked in both registers rather than spot-checked.
    for (const source of ['dark', 'light'] as const) {
      await switchTo(source);
      const empty = await chrome.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const layer = document.getElementById('wigolo-tokens')!.textContent!;
        const names = [...new Set(layer.match(/--[a-z][a-z0-9-]*(?=\s*:)/g) ?? [])];
        return names.filter((n) => style.getPropertyValue(n).trim() === '');
      });
      expect(empty, `unresolved in the ${source} register`).toEqual([]);
    }
  });
});
