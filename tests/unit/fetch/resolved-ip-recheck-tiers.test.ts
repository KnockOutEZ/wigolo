import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// WHY (#207 test plan): TLS impersonation and the browser cannot pin the
// socket. This file locks the floor that remains — the resolved-IP re-check
// still runs, and a metadata resolution is refused before the backend/nav.

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup(
      hostname: string,
      options: unknown,
      callback?: (err: Error | null, address: unknown, family?: number) => void,
    ) {
      const cb = typeof options === 'function' ? options : callback!;
      const addrs =
        hostname === 'rebind.evil.example'
          ? [{ address: '169.254.169.254', family: 4 }]
          : [{ address: '93.184.216.34', family: 4 }];
      const wantsAll =
        typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
      if (wantsAll) cb(null, addrs);
      else cb(null, addrs[0]!.address, addrs[0]!.family);
    },
  };
});

const goto = vi.fn().mockResolvedValue({
  status: () => 200,
  url: () => 'https://rebind.evil.example/',
  headers: () => ({ 'content-type': 'text/html' }),
});

function makePage() {
  return {
    goto,
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ textLen: 1000, nodes: 8 }),
    content: vi.fn().mockResolvedValue('<html><body>should not render</body></html>'),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext() {
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockResolvedValue([]),
    addCookies: vi.fn().mockResolvedValue(undefined),
  };
}

function makeBrowser() {
  return {
    newContext: vi.fn().mockResolvedValue(makeContext()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation(() => Promise.resolve(makeBrowser()));
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import {
  tlsFetch,
  _setTlsBackendForTests,
  _resetTlsBackend,
} from '../../../src/fetch/tls-tier.js';
import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

describe('TLS / browser resolved-IP re-check (check-only floor)', () => {
  beforeEach(() => {
    resetConfig();
    goto.mockClear();
    _setTlsBackendForTests(null);
    _resetTlsBackend();
  });

  afterEach(() => {
    resetConfig();
    _setTlsBackendForTests(null);
    _resetTlsBackend();
  });

  it('tlsFetch refuses a hostname that resolves to 169.254.169.254 before the backend connects', async () => {
    const fetched: string[] = [];
    _setTlsBackendForTests({
      fetch: async (url) => {
        fetched.push(url);
        return {
          status: 200,
          url,
          headers: { entries: function* () { yield ['content-type', 'text/html']; } },
          text: async () => '<html>should not run</html>',
        };
      },
    });
    await expect(tlsFetch('https://rebind.evil.example/')).rejects.toThrow(
      /metadata|link-local|blocked/i,
    );
    expect(fetched).toEqual([]);
  });

  it('browser fetch refuses a hostname that resolves to 169.254.169.254 before navigation', async () => {
    const pool = new MultiBrowserPool();
    try {
      await expect(pool.fetchWithBrowser('https://rebind.evil.example/')).rejects.toThrow(
        /metadata|link-local|blocked/i,
      );
      expect(goto).not.toHaveBeenCalled();
    } finally {
      await pool.shutdown();
    }
  });
});
