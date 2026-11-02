import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';

// `useAuth` / WIGOLO_AUTH_STATE_PATH plumbs a Playwright storageState path from
// config through the fetch router into the browser pool. The pool used to only
// read it as a gate (skip cdp-direct) and never seed the context, so an
// authenticated fetch ran as a logged-out visitor. These tests pin that the
// path reaches `newContext({ storageState })` for contexts the pool creates,
// and that such a context is not pooled for a later unauthenticated fetch.

const state = {
  contextOptions: [] as Array<Record<string, unknown> | undefined>,
};

function makePage() {
  return {
    goto: vi.fn().mockResolvedValue({
      status: () => 200,
      url: () => 'https://example.com',
      headers: () => ({ 'content-type': 'text/html' }),
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ textLen: 1000, nodes: 20 }),
    content: vi.fn().mockResolvedValue('<html><body>ok</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const makeContext = (options?: Record<string, unknown>) => {
    state.contextOptions.push(options);
    return {
      newPage: vi.fn().mockResolvedValue(makePage()),
      addInitScript: vi.fn().mockResolvedValue(undefined),
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
  };

  const launch = vi.fn().mockResolvedValue({
    newContext: vi
      .fn()
      .mockImplementation((options?: Record<string, unknown>) =>
        Promise.resolve(makeContext(options)),
      ),
    version: () => '142.0.0.0',
    close: vi.fn().mockResolvedValue(undefined),
  });

  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

describe('browser-pool auth state seeding', () => {
  let authStatePath: string;

  beforeEach(() => {
    resetConfig();
    state.contextOptions.length = 0;
    authStatePath = join(mkdtempSync(join(tmpdir(), 'wigolo-auth-')), 'state.json');
    writeFileSync(
      authStatePath,
      JSON.stringify({ cookies: [], origins: [] }),
      'utf-8',
    );
  });

  afterEach(() => {
    resetConfig();
  });

  it('seeds a context the pool creates with the configured auth state', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com/', {
      storageStatePath: authStatePath,
    });

    expect(state.contextOptions).toHaveLength(1);
    expect(state.contextOptions[0]).toMatchObject({ storageState: authStatePath });
    await pool.shutdown();
  });

  it('does not seed a context when no auth state is configured', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com/');

    expect(state.contextOptions).toHaveLength(1);
    expect(state.contextOptions[0]).not.toHaveProperty('storageState');
    await pool.shutdown();
  });

  it('does not pool an auth-seeded context for a later unauthenticated fetch', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com/', {
      storageStatePath: authStatePath,
    });
    await pool.fetchWithBrowser('https://example.com/');

    // A second, fresh context proves the authenticated one was closed on
    // release instead of being reused with its cookies still attached.
    expect(state.contextOptions).toHaveLength(2);
    expect(state.contextOptions[1]).not.toHaveProperty('storageState');
    await pool.shutdown();
  });
});
