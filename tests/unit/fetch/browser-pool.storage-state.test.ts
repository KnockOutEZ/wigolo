import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfig } from '../../../src/config.js';

// --- programmable browser launcher capturing newContext options ---
const state: {
  newContextOptions: Array<Record<string, unknown>>;
  closedContexts: number;
  closedBrowsers: number;
  releasedToPool: number;
} = {
  newContextOptions: [],
  closedContexts: 0,
  closedBrowsers: 0,
  releasedToPool: 0,
};

function makePage() {
  return {
    goto: vi.fn().mockResolvedValue({ status: () => 200, url: () => 'https://example.com/', headers: () => ({}) }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ textLen: 100, nodes: 2 }),
    content: vi.fn().mockResolvedValue('<html><body>ok</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    context: () => ({ cookies: () => Promise.resolve([]) }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext() {
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    addCookies: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(() => {
      state.closedContexts++;
      return Promise.resolve(undefined);
    }),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockResolvedValue([]),
  };
}

function makeBrowser() {
  return {
    newContext: vi.fn().mockImplementation((opts?: Record<string, unknown>) => {
      state.newContextOptions.push(opts ?? {});
      const ctx = makeContext();
      return Promise.resolve(ctx);
    }),
    close: vi.fn().mockImplementation(() => {
      state.closedBrowsers++;
      return Promise.resolve(undefined);
    }),
  };
}

// The pool's context-acquisition path calls pool.launch() -> browser.newContext()
// for the FIRST pooled fetch. For storage-state fetches we launch a DEDICATED
// throwaway browser directly (getLauncher().launch), never touching the pool.
vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation(() => Promise.resolve(makeBrowser()));
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

vi.mock('node:dns', () => ({
  lookup: (_h: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) =>
    cb(null, [{ address: '203.0.113.10', family: 4 }]),
}));

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

function reset() {
  state.newContextOptions = [];
  state.closedContexts = 0;
  state.closedBrowsers = 0;
  state.releasedToPool = 0;
}

function makeStateFile(dir: string, body: unknown): string {
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe('browser-pool storage-state restore (useAuth)', () => {
  beforeEach(() => {
    resetConfig();
    reset();
  });
  afterEach(() => {
    resetConfig();
  });

  it('creates a dedicated context seeded WITH the storageState option', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-ss-'));
    const stateFile = makeStateFile(dir, {
      cookies: [{ name: 'SID', value: 'live', domain: '.google.com', path: '/', expires: 1893456000 }],
      origins: [],
    });
    try {
      const pool = new MultiBrowserPool();
      await pool.fetchWithBrowser('https://example.com/', { storageStatePath: stateFile });

      // A dedicated context was created for the auth fetch, with the full
      // storageState handed to Playwright (not manually re-applied).
      const ctxOpts = state.newContextOptions;
      expect(ctxOpts.length).toBeGreaterThan(0);
      expect(ctxOpts[0].storageState).toBe(stateFile);
      await pool.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes the dedicated context + browser (never released to the pool)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-ss-'));
    const stateFile = makeStateFile(dir, { cookies: [], origins: [] });
    try {
      const pool = new MultiBrowserPool();
      await pool.fetchWithBrowser('https://example.com/', { storageStatePath: stateFile });

      expect(state.closedContexts).toBeGreaterThan(0);
      expect(state.closedBrowsers).toBeGreaterThan(0);
      await pool.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not leak account state to a later pooled fetch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-ss-'));
    const stateFile = makeStateFile(dir, {
      cookies: [{ name: 'SID', value: 'ACCOUNT_A', domain: '.google.com', path: '/', expires: 1893456000 }],
      origins: [],
    });
    try {
      const pool = new MultiBrowserPool();

      // Authenticated fetch (dedicated context seeded with ACCOUNT_A state).
      await pool.fetchWithBrowser('https://account-a.example/', { storageStatePath: stateFile });

      // Anonymous fetch straight after — must get a POOLED context with NO
      // storageState, so it cannot see ACCOUNT_A's cookies.
      await pool.fetchWithBrowser('https://anonymous.example/');

      const anonymousCtxOpts = state.newContextOptions.at(-1) ?? {};
      expect(anonymousCtxOpts.storageState).toBeUndefined();
      await pool.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('left the pooled path byte-identical when no storageStatePath is given', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com/');

    const ctxOpts = state.newContextOptions;
    expect(ctxOpts.length).toBeGreaterThan(0);
    // Pooled acquisition creates a context WITHOUT storageState.
    expect(ctxOpts[0].storageState).toBeUndefined();
    await pool.shutdown();
  });
});