import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

/**
 * The hardened stealth driver ships as an optional dependency and resolves a
 * browser revision it neither installs nor owns. `resolveStealthLauncher` only
 * proves the module IMPORTS — never that it can LAUNCH.
 *
 * Before this fix the launcher was resolved once and every launch site used it:
 * the only try/catch fell back from `channel:'chrome'` to bundled through the
 * SAME launcher, so a driver that imported but could not launch hard-failed the
 * fetch with no path back to the standard driver. A version skew between the two
 * packages would have taken out every anti-bot fetch, silently.
 *
 * The pool must degrade to the standard launcher instead, and remember it.
 */

interface State {
  hardenedAttempts: number;
  standardLaunches: Array<Record<string, unknown>>;
  hardenedWorks: boolean;
}
const state: State = { hardenedAttempts: 0, standardLaunches: [], hardenedWorks: false };

function makePage() {
  return {
    goto: vi.fn().mockResolvedValue({
      status: () => 200,
      url: () => 'https://example.com',
      headers: () => ({ 'content-type': 'text/html' }),
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation((src: string) =>
      typeof src === 'string' && src.includes('hasContent')
        ? Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false })
        : Promise.resolve({ textLen: 1000, nodes: 8 })),
    content: vi.fn().mockResolvedValue('<html><body>real content here</body></html>'),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
function makeBrowser() {
  return {
    version: vi.fn(() => '142.0.7444.0'),
    newContext: vi.fn().mockResolvedValue({
      addInitScript: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(makePage()),
      cookies: vi.fn().mockResolvedValue([]),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    state.standardLaunches.push(opts);
    return Promise.resolve(makeBrowser());
  });
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';
import { _setStealthDriverForTests, type StealthDriverLauncher } from '../../../src/fetch/stealth.js';

/** A hardened driver that IMPORTS fine but always fails to LAUNCH — the exact
 *  shape of a browser-revision skew between the two packages. */
function brokenHardenedDriver(): StealthDriverLauncher {
  return {
    launch: vi.fn(() => {
      state.hardenedAttempts++;
      return Promise.reject(new Error("Executable doesn't exist at .../chrome-1223/chrome"));
    }),
  } as unknown as StealthDriverLauncher;
}

describe('dedicated stealth launch degrades when the hardened driver cannot launch', () => {
  beforeEach(() => {
    state.hardenedAttempts = 0;
    state.standardLaunches = [];
    process.env.WIGOLO_STEALTH_DRIVER = 'auto';
    process.env.WIGOLO_BROWSER_CHANNEL = 'chromium'; // isolate the driver axis
    resetConfig();
  });
  afterEach(() => {
    _setStealthDriverForTests(undefined);
    process.env.WIGOLO_STEALTH_DRIVER = 'playwright';
    delete process.env.WIGOLO_BROWSER_CHANNEL;
    resetConfig();
  });

  it('falls back to the standard driver instead of hard-failing the fetch', async () => {
    _setStealthDriverForTests(brokenHardenedDriver());
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://blocked.example', { stealth: true });

    expect(result.method).toBe('browser');
    expect(state.hardenedAttempts).toBeGreaterThan(0);
    expect(state.standardLaunches.length).toBe(1);
    await pool.shutdown();
  });

  it('remembers the failure — a second fetch does not re-attempt the broken driver', async () => {
    _setStealthDriverForTests(brokenHardenedDriver());
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });
    const attemptsAfterFirst = state.hardenedAttempts;
    await pool.fetchWithBrowser('https://b.example', { stealth: true });

    expect(state.hardenedAttempts).toBe(attemptsAfterFirst);
    expect(state.standardLaunches.length).toBe(2);
    await pool.shutdown();
  });

  it('still uses the hardened driver when it CAN launch (no needless downgrade)', async () => {
    const working = {
      launch: vi.fn(() => {
        state.hardenedAttempts++;
        return Promise.resolve(makeBrowser());
      }),
    } as unknown as StealthDriverLauncher;
    _setStealthDriverForTests(working);
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://a.example', { stealth: true });
    await pool.fetchWithBrowser('https://b.example', { stealth: true });

    expect(state.hardenedAttempts).toBe(2);
    expect(state.standardLaunches.length).toBe(0);
    await pool.shutdown();
  });
});
