import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// Shared mock state for the persistent-profile (userDataDir) launch path.
interface ProfileState {
  persistentContextsCreated: number;
  persistentContextsClosed: number;
  addInitScriptCalls: number;
  cdpConnects: number;
  // When set, page.goto rejects — simulates a fetch failure after launch.
  gotoThrows: boolean;
  // When set, launchPersistentContext rejects — simulates a launch failure.
  persistentLaunchThrows: boolean;
}

const state: ProfileState = {
  persistentContextsCreated: 0,
  persistentContextsClosed: 0,
  addInitScriptCalls: 0,
  cdpConnects: 0,
  gotoThrows: false,
  persistentLaunchThrows: false,
};

function makePage() {
  return {
    goto: vi.fn().mockImplementation(() => {
      if (state.gotoThrows) return Promise.reject(new Error('goto boom'));
      return Promise.resolve({
        status: () => 200,
        url: () => 'https://example.com',
        headers: () => ({ 'content-type': 'text/html' }),
      });
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    // settlePage reads content metrics + the final DOM verdict via evaluate;
    // a content-bearing verdict keeps the settle gate on its instant path.
    evaluate: vi.fn().mockResolvedValue({
      hasContent: true,
      hasSpaRoot: false,
      hasNavChrome: false,
      nearEmpty: false,
    }),
    content: vi.fn().mockResolvedValue('<html><body>ok</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makePersistentContext() {
  state.persistentContextsCreated++;
  return {
    addInitScript: vi.fn().mockImplementation(() => {
      state.addInitScriptCalls++;
      return Promise.resolve(undefined);
    }),
    close: vi.fn().mockImplementation(() => {
      state.persistentContextsClosed++;
      return Promise.resolve(undefined);
    }),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockResolvedValue([]),
  };
}

function makePooledContext() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockResolvedValue([]),
  };
}

function makeBrowser() {
  return {
    newContext: vi.fn().mockImplementation(() => Promise.resolve(makePooledContext())),
    contexts: vi.fn().mockReturnValue([makePooledContext()]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation(() => Promise.resolve(makeBrowser()));
  const launchPersistentContext = vi.fn().mockImplementation(() => {
    if (state.persistentLaunchThrows) return Promise.reject(new Error('persistent launch boom'));
    return Promise.resolve(makePersistentContext());
  });
  const connectOverCDP = vi.fn().mockImplementation(() => {
    state.cdpConnects++;
    return Promise.resolve(makeBrowser());
  });
  return {
    chromium: { launch, launchPersistentContext, connectOverCDP },
    firefox: { launch },
    webkit: { launch },
  };
});

import { chromium } from 'playwright';
import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

function resetState() {
  state.persistentContextsCreated = 0;
  state.persistentContextsClosed = 0;
  state.addInitScriptCalls = 0;
  state.cdpConnects = 0;
  state.gotoThrows = false;
  state.persistentLaunchThrows = false;
}

describe('browser-pool persistent profile (userDataDir) path — issue #161', () => {
  beforeEach(() => {
    resetConfig();
    resetState();
    vi.mocked(chromium.launchPersistentContext).mockClear();
    vi.mocked(chromium.connectOverCDP).mockClear();
  });

  it('launches a persistent context FROM the copied profile dir and closes it at end-of-fetch', async () => {
    const pool = new MultiBrowserPool();
    const proto = Object.getPrototypeOf(pool) as {
      releaseForType: (...args: unknown[]) => void;
    };
    const releaseSpy = vi.spyOn(proto, 'releaseForType');

    const result = await pool.fetchWithBrowser('https://intranet.example', {
      userDataDir: '/tmp/wigolo-chrome-abc123',
    });
    expect(result.method).toBe('browser');

    // The copied profile dir was actually consumed (regression for the dead
    // userDataDir option): passed as the persistent-context user data dir.
    expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chromium.launchPersistentContext).mock.calls[0][0]).toBe('/tmp/wigolo-chrome-abc123');
    expect(vi.mocked(chromium.launchPersistentContext).mock.calls[0][1]).toMatchObject({ headless: true });

    // Dedicated lifecycle: closed at end-of-fetch, never handed to the pool.
    expect(state.persistentContextsCreated).toBe(1);
    expect(state.persistentContextsClosed).toBe(1);
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(pool.getStats()[0].pooledCount).toBe(0);

    releaseSpy.mockRestore();
    await pool.shutdown();
  });

  it('closes the persistent context even when the fetch fails (goto rejects)', async () => {
    state.gotoThrows = true;
    const pool = new MultiBrowserPool();

    await expect(
      pool.fetchWithBrowser('https://intranet.example', { userDataDir: '/tmp/wigolo-chrome-err' }),
    ).rejects.toThrow(/goto boom/);

    expect(state.persistentContextsCreated).toBe(1);
    expect(state.persistentContextsClosed).toBe(1);

    await pool.shutdown();
  });

  it('cdpUrl takes precedence over userDataDir (WIGOLO_CDP_URL path unchanged)', async () => {
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://intranet.example', {
      cdpUrl: 'http://localhost:9222',
      userDataDir: '/tmp/wigolo-chrome-abc123',
    });
    expect(result.method).toBe('browser');

    expect(state.cdpConnects).toBe(1);
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();

    await pool.shutdown();
  });

  it('userDataDir wins over stealth — the profile fingerprint is presented, not the hardened one', async () => {
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://intranet.example', {
      userDataDir: '/tmp/wigolo-chrome-abc123',
      stealth: true,
    });
    expect(result.method).toBe('browser');

    expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(1);
    // The stealth init script must NOT be applied to the profile context.
    expect(state.addInitScriptCalls).toBe(0);
    expect(state.persistentContextsClosed).toBe(1);

    await pool.shutdown();
  });

  it('a persistent-launch failure frees the dedicated slot (no semaphore leak)', async () => {
    process.env.MAX_BROWSERS = '1';
    resetConfig();
    state.persistentLaunchThrows = true;

    const pool = new MultiBrowserPool();
    await expect(
      pool.fetchWithBrowser('https://intranet.example', { userDataDir: '/tmp/wigolo-chrome-fail' }),
    ).rejects.toThrow(/persistent launch boom/);

    // With limit=1, a leaked slot would hang the next dedicated fetch.
    state.persistentLaunchThrows = false;
    const result = await pool.fetchWithBrowser('https://intranet.example', {
      userDataDir: '/tmp/wigolo-chrome-ok',
    });
    expect(result.method).toBe('browser');

    delete process.env.MAX_BROWSERS;
    await pool.shutdown();
  });
});
