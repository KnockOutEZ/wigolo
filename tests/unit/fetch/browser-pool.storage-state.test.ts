import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfig } from '../../../src/config.js';

// --- programmable page/context behaviour (mirrors browser-pool.clearance.test.ts) ---
const state: {
  addCookiesCalls: Array<Array<{ name: string; value: string; domain: string; expires?: number; expiresAt?: number }>>;
  addInitScriptCalls: string[];
} = {
  addCookiesCalls: [],
  addInitScriptCalls: [],
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
    addInitScript: vi.fn().mockImplementation((s: string) => {
      state.addInitScriptCalls.push(s);
      return Promise.resolve(undefined);
    }),
    addCookies: vi.fn().mockImplementation((c: State['addCookiesCalls'][number]) => {
      state.addCookiesCalls.push(c);
      return Promise.resolve(undefined);
    }),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockResolvedValue([]),
  };
}

function makeBrowser() {
  return {
    newContext: vi.fn().mockImplementation(() => Promise.resolve(makeContext())),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

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

const FUTURE = Math.floor(Date.now() / 1000) + 86400;
const PAST = Math.floor(Date.now() / 1000) - 86400;

type State = typeof state;

function reset() {
  state.addCookiesCalls = [];
  state.addInitScriptCalls = [];
}

describe('browser-pool storage-state restore (useAuth)', () => {
  beforeEach(() => {
    resetConfig();
    reset();
  });
  afterEach(() => {
    resetConfig();
  });

  it('applies storageStatePath cookies (dropping expired ones) via context.addCookies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-ss-'));
    const stateFile = join(dir, 'state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({
        cookies: [
          { name: 'SID', value: 'live', domain: '.google.com', path: '/', expires: FUTURE, httpOnly: true, secure: true },
          { name: 'STALE', value: 'dead', domain: '.google.com', path: '/', expires: PAST, httpOnly: true, secure: true },
        ],
        origins: [],
      }),
    );
    try {
      const pool = new MultiBrowserPool();
      await pool.fetchWithBrowser('https://example.com/', { storageStatePath: stateFile });

      expect(state.addCookiesCalls.length).toBe(1);
      const applied = state.addCookiesCalls[0];
      const names = applied.map((c) => c.name);
      expect(names).toContain('SID');
      expect(names).not.toContain('STALE');
      await pool.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers an addInitScript restoring origin localStorage from the storage state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-ss-'));
    const stateFile = join(dir, 'state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({
        cookies: [],
        origins: [{ origin: 'https://example.com', localStorage: [{ name: 'theme', value: 'dark' }] }],
      }),
    );
    try {
      const pool = new MultiBrowserPool();
      await pool.fetchWithBrowser('https://example.com/', { storageStatePath: stateFile });

      expect(state.addInitScriptCalls.length).toBe(1);
      expect(state.addInitScriptCalls[0]).toContain('theme');
      await pool.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades gracefully when the storage state file is unreadable or malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-ss-'));
    const stateFile = join(dir, 'bad.json');
    writeFileSync(stateFile, 'not-json{');
    try {
      const pool = new MultiBrowserPool();
      const result = await pool.fetchWithBrowser('https://example.com/', { storageStatePath: stateFile });
      expect(result).toBeDefined();
      // Nothing was applied, but the fetch itself still succeeded.
      expect(state.addCookiesCalls.length).toBe(0);
      await pool.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when storageStatePath is absent', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com/');
    expect(state.addCookiesCalls.length).toBe(0);
    expect(state.addInitScriptCalls.length).toBe(0);
    await pool.shutdown();
  });
});