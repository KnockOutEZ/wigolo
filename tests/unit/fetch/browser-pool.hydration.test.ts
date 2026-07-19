import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// React.dev ships a populated nav-shell that clears networkidle while
// <main> stays empty. The browser-pool path (used by search/research/agent
// fetches) must wait for semantic content before extracting, otherwise
// bench category #2 leaks nav-only shells with no article text.

const calls = {
  waitForFunction: 0,
};

vi.mock('playwright', () => {
  const launch = vi.fn().mockResolvedValue({
    newContext: vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockImplementation(() => ({
        goto: vi.fn().mockResolvedValue({
          status: () => 200,
          url: () => 'https://react.dev/learn',
          headers: () => ({ 'content-type': 'text/html' }),
        }),
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        waitForFunction: vi.fn().mockImplementation(() => {
          calls.waitForFunction += 1;
          return Promise.resolve(undefined);
        }),
        // settlePage reads content metrics + the final DOM verdict via evaluate.
        evaluate: vi.fn().mockImplementation((src: string) =>
          typeof src === 'string' && src.includes('hasContent')
            ? Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false })
            : Promise.resolve({ textLen: 1000, nodes: 8 })),
        content: vi.fn().mockResolvedValue(
          '<html><body><main>hydrated article text many many words enough to count as content</main></body></html>',
        ),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
        setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      })),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  });
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

describe('browser-pool waits for hydrated semantic content', () => {
  beforeEach(() => {
    resetConfig();
    calls.waitForFunction = 0;
  });
  afterEach(() => resetConfig());

  it('invokes waitForFunction (semantic-content probe) after networkidle', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://react.dev/learn');
    expect(calls.waitForFunction).toBeGreaterThanOrEqual(1);
    await pool.shutdown();
  });
});
