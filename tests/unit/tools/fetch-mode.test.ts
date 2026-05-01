import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFetch } from '../../../src/tools/fetch.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { resetConfig } from '../../../src/config.js';

describe('fetch mode validation', () => {
  beforeEach(() => { initDatabase(':memory:'); resetConfig(); });
  afterEach(() => { closeDatabase(); resetConfig(); });

  it('rejects unknown mode', async () => {
    const router = { fetch: vi.fn() } as unknown as SmartRouter;
    await expect(
      handleFetch({ url: 'https://example.com', mode: 'turbo' as 'fast' }, router),
    ).rejects.toThrow(/mode.*fast.*balanced.*deep/i);
  });
});

describe('fetch mode=fast', () => {
  beforeEach(() => { initDatabase(':memory:'); resetConfig(); });
  afterEach(() => { closeDatabase(); resetConfig(); });

  it('passes mode=fast and renderJs=never to the router', async () => {
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com/',
        finalUrl: 'https://example.com/',
        html: '<html><body><p>hello world</p></body></html>',
        contentType: 'text/html',
        statusCode: 200,
        method: 'http',
        headers: {},
      }),
    } as unknown as SmartRouter;

    await handleFetch({ url: 'https://example.com/', mode: 'fast' }, router);

    expect(router.fetch).toHaveBeenCalledWith(
      'https://example.com/',
      expect.objectContaining({ mode: 'fast', renderJs: 'never' }),
    );
  });

  it('surfaces js_required when the router marks the raw result as a JS shell', async () => {
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://spa.test/',
        finalUrl: 'https://spa.test/',
        html: '<div id="root"></div>',
        contentType: 'text/html',
        statusCode: 200,
        method: 'http',
        headers: {},
        jsRequired: true,
      }),
    } as unknown as SmartRouter;
    const out = await handleFetch({ url: 'https://spa.test/', mode: 'fast' }, router);
    expect(out.js_required).toBe(true);
  });
});
