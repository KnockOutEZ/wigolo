import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// #526: an auth storage-state path reached fetchWithBrowser but no browser
// context was ever created with it, so authenticated fetches ran logged out.
// Records every newContext call's options and each context's lifecycle.
interface State {
  newContextOptions: Array<Record<string, unknown> | undefined>;
  contextsCreated: number;
  contextsClosed: number;
  browsersClosed: number;
  // Contexts a CDP-attached browser already has (connectOverCDP only).
  cdpExistingContexts: number;
  // Fault injection for the fallback and cleanup paths.
  cdpConnectFails: boolean;
  cdpNewContextFails: boolean;
  headersFail: boolean;
  // When set, page.goto waits on this promise (to hold fetches in flight).
  gotoGate: Promise<void> | null;
}

const state: State = {
  newContextOptions: [],
  contextsCreated: 0,
  contextsClosed: 0,
  browsersClosed: 0,
  cdpExistingContexts: 0,
  cdpConnectFails: false,
  cdpNewContextFails: false,
  headersFail: false,
  gotoGate: null,
};

function makePage() {
  return {
    goto: vi.fn().mockImplementation(async () => {
      if (state.gotoGate) await state.gotoGate;
      return {
        status: () => 200,
        url: () => 'https://example.com',
        headers: () => ({ 'content-type': 'text/html' }),
      };
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation((src: string) =>
      typeof src === 'string' && src.includes('hasContent')
        ? Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false })
        : Promise.resolve({ textLen: 1000, nodes: 8 })),
    content: vi.fn().mockResolvedValue('<html><body>ok</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
    setExtraHTTPHeaders: vi.fn().mockImplementation(() =>
      state.headersFail ? Promise.reject(new Error('headers failed')) : Promise.resolve(undefined)),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext() {
  state.contextsCreated++;
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(() => {
      state.contextsClosed++;
      return Promise.resolve(undefined);
    }),
    newPage: vi.fn().mockImplementation(() => Promise.resolve(makePage())),
    cookies: vi.fn().mockResolvedValue([]),
  };
}

function makeBrowser(existingContexts = 0, newContextFails = false) {
  const existing = Array.from({ length: existingContexts }, () => makeContext());
  return {
    version: vi.fn().mockReturnValue('142.0.7444.0'),
    contexts: vi.fn().mockReturnValue(existing),
    newContext: vi.fn().mockImplementation((options?: Record<string, unknown>) => {
      if (newContextFails) return Promise.reject(new Error('newContext failed'));
      state.newContextOptions.push(options);
      return Promise.resolve(makeContext());
    }),
    close: vi.fn().mockImplementation(() => {
      state.browsersClosed++;
      return Promise.resolve(undefined);
    }),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation(() => Promise.resolve(makeBrowser()));
  const connectOverCDP = vi.fn().mockImplementation(() =>
    state.cdpConnectFails
      ? Promise.reject(new Error('connect refused'))
      : Promise.resolve(makeBrowser(state.cdpExistingContexts, state.cdpNewContextFails)));
  const stub = { launch, connectOverCDP };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

const STATE_PATH = '/tmp/wigolo-auth-state.json';

describe('browser-pool applies the auth storage state (#526)', () => {
  beforeEach(() => {
    resetConfig();
    state.newContextOptions = [];
    state.contextsCreated = 0;
    state.contextsClosed = 0;
    state.browsersClosed = 0;
    state.cdpExistingContexts = 0;
    state.cdpConnectFails = false;
    state.cdpNewContextFails = false;
    state.headersFail = false;
    state.gotoGate = null;
  });
  afterEach(() => {
    delete process.env.MAX_BROWSERS;
    resetConfig();
  });

  it('creates the context with the storage state and closes it at the end of the fetch', async () => {
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://example.com', { storageStatePath: STATE_PATH });
    expect(result.method).toBe('browser');

    expect(state.newContextOptions).toEqual([{ acceptDownloads: true, storageState: STATE_PATH }]);
    // Closed, not released to the pool; the shared browser stays up.
    expect(state.contextsClosed).toBe(1);
    expect(state.browsersClosed).toBe(0);
    await pool.shutdown();
  });

  it('never hands an authenticated context to a later anonymous fetch', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com/account', { storageStatePath: STATE_PATH });
    await pool.fetchWithBrowser('https://example.com/');

    expect(state.contextsCreated).toBe(2);
    expect(state.newContextOptions[1]).toEqual({ acceptDownloads: true });
    expect(state.newContextOptions[1]).not.toHaveProperty('storageState');
    await pool.shutdown();
  });

  it('leaves the pooled path unchanged without a storage state', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com/');
    await pool.fetchWithBrowser('https://example.com/again');

    // One pooled context, reused, and not closed between fetches.
    expect(state.newContextOptions).toEqual([{ acceptDownloads: true }]);
    expect(state.contextsClosed).toBe(0);
    await pool.shutdown();
  });

  it('seeds the dedicated stealth context too', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com', { stealth: true, storageStatePath: STATE_PATH });

    expect(state.newContextOptions).toHaveLength(1);
    expect(state.newContextOptions[0]).toMatchObject({ storageState: STATE_PATH });
    expect(state.contextsClosed).toBe(1);
    await pool.shutdown();
  });

  it('seeds a new context on a CDP browser that has none', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com', {
      cdpUrl: 'http://127.0.0.1:9222',
      storageStatePath: STATE_PATH,
    });

    expect(state.newContextOptions).toEqual([{ storageState: STATE_PATH }]);
    await pool.shutdown();
  });

  it("drives a CDP browser's existing context as before, which cannot take a storage state", async () => {
    state.cdpExistingContexts = 1;
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://example.com', {
      cdpUrl: 'http://127.0.0.1:9222',
      storageStatePath: STATE_PATH,
    });

    expect(result.method).toBe('browser');
    expect(state.newContextOptions).toEqual([]);
    await pool.shutdown();
  });

  it('keeps the storage state when the CDP connection fails and the fetch falls back to a local browser', async () => {
    state.cdpConnectFails = true;
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://example.com', {
      cdpUrl: 'http://127.0.0.1:9222',
      storageStatePath: STATE_PATH,
    });

    expect(result.method).toBe('browser');
    expect(state.newContextOptions).toEqual([{ acceptDownloads: true, storageState: STATE_PATH }]);
    expect(state.contextsClosed).toBe(1);
    await pool.shutdown();
  });

  it('when a CDP context cannot be created, closes that connection and cleans up the local fallback context', async () => {
    state.cdpNewContextFails = true;
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com', {
      cdpUrl: 'http://127.0.0.1:9222',
      storageStatePath: STATE_PATH,
    });

    // The CDP connection was closed, and the seeded fallback context was closed
    // too (before, the finally closed only the CDP connection).
    expect(state.browsersClosed).toBe(1);
    expect(state.newContextOptions).toEqual([{ acceptDownloads: true, storageState: STATE_PATH }]);
    expect(state.contextsClosed).toBe(1);
    await pool.shutdown();
  });

  it('releases the pooled fallback context back to the pool after a CDP context failure without a storage state', async () => {
    state.cdpNewContextFails = true;
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com', { cdpUrl: 'http://127.0.0.1:9222' });
    await pool.fetchWithBrowser('https://example.com/again');

    // The second fetch reuses the context the first released.
    expect(state.newContextOptions).toEqual([{ acceptDownloads: true }]);
    await pool.shutdown();
  });

  it('bounds concurrent authenticated contexts at maxBrowsers', async () => {
    process.env.MAX_BROWSERS = '1';
    resetConfig();
    let open!: () => void;
    state.gotoGate = new Promise<void>((resolve) => { open = resolve; });
    const pool = new MultiBrowserPool();

    const first = pool.fetchWithBrowser('https://example.com/a', { storageStatePath: STATE_PATH });
    const second = pool.fetchWithBrowser('https://example.com/b', { storageStatePath: STATE_PATH });
    await new Promise((r) => setTimeout(r, 20));
    // The second fetch waits for a slot instead of opening another context.
    expect(state.contextsCreated).toBe(1);

    open();
    await Promise.all([first, second]);
    expect(state.contextsCreated).toBe(2);
    expect(state.contextsClosed).toBe(2);
    await pool.shutdown();
  });

  it('closes the authenticated context when setting the request headers fails', async () => {
    state.headersFail = true;
    const pool = new MultiBrowserPool();
    await expect(pool.fetchWithBrowser('https://example.com', {
      storageStatePath: STATE_PATH,
      headers: { 'x-test': '1' },
    })).rejects.toThrow('headers failed');

    expect(state.contextsClosed).toBe(1);
    await pool.shutdown();
  });
});
