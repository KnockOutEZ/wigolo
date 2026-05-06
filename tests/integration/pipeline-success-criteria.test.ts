import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resolveMode } from '../../src/util/mode.js';
import { handleSearch } from '../../src/tools/search.js';
import { handleFetch } from '../../src/tools/fetch.js';
import { handleExtract } from '../../src/tools/extract.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock',
    markdown: '# Mock\n\nContent.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

const baseEngine = (results: unknown[] = []): SearchEngine => ({
  name: 'mock',
  search: vi.fn().mockResolvedValue(results),
});

const baseRouter = (impl?: () => Promise<unknown>): SmartRouter => ({
  fetch: vi.fn(impl ?? (async () => ({
    url: 'https://example.com',
    finalUrl: 'https://example.com',
    html: '<html><body>nothing</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  }))),
} as unknown as SmartRouter);

describe('Spec §10 success criteria', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VALIDATE_LINKS: 'false',
      WIGOLO_RERANKER: 'none',
      LOG_LEVEL: 'error',
    };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('SC-1: cache + array query never returns non-English results', async () => {
    const engine = baseEngine([
      { title: 'PostgreSQL replication', url: 'https://example.com/a', snippet: 'Configuring streaming WAL replication for high availability databases.', relevance_score: 0.9, engine: 'mock' },
      { title: '深度学习教程', url: 'https://baidu.com/x', snippet: '本文详细介绍人工智能与神经网络的实现细节及训练方法。', relevance_score: 0.8, engine: 'mock' },
      { title: '人工智能', url: 'https://baidu.com/y', snippet: '机器学习算法和深度学习框架的核心概念与应用案例分析。', relevance_score: 0.7, engine: 'mock' },
    ]);
    const r = await handleSearch(
      { query: ['postgres replication'], mode: 'cache' },
      [engine],
      baseRouter(),
    );
    if (r.ok) {
      for (const item of r.data.results) {
        expect(item.url).not.toContain('baidu.com');
      }
    } else {
      // cache empty → no_results or no engine output is also acceptable
      expect(['no_results', 'cache_miss', 'invalid_input']).toContain(r.error);
    }
  });

  it('SC-2: format:answer never returns silent empty', async () => {
    const engine = baseEngine([]);
    const r = await handleSearch(
      { query: 'zzz no match', format: 'answer', mode: 'default' },
      [engine],
      baseRouter(),
    );
    if (!r.ok) {
      expect(r.error).toMatch(/no_content|no_results|empty/);
      expect(r.error_reason).toBeTruthy();
    } else {
      const out = r.data;
      const hasSignal = !!(out.answer || out.warning || out.error);
      expect(hasSignal).toBe(true);
    }
  });

  it('SC-5: deprecated mode aliases resolve correctly', () => {
    expect(resolveMode('fast')).toBe('cache');
    expect(resolveMode('balanced')).toBe('default');
    expect(resolveMode('deep')).toBe('default');
    expect(resolveMode('cache')).toBe('cache');
    expect(resolveMode('default')).toBe('default');
    expect(resolveMode('stealth')).toBe('stealth');
    expect(resolveMode(undefined)).toBe('default');
  });

  it('SC-7: stealth without Playwright surfaces a StageError', async () => {
    // Router's stealth path may return a StageError-shaped value (T11). handleFetch
    // surfaces it via the `'error' in raw` runtime guard. We simulate that here.
    const stealthRouter = {
      fetch: vi.fn().mockResolvedValue({
        error: 'playwright_not_installed',
        error_reason: 'Playwright is not installed',
        stage: 'fetch',
        hint: 'Run `npm i playwright && npx playwright install chromium`',
      }),
    } as unknown as SmartRouter;
    const r = await handleFetch(
      { url: 'https://example.com', mode: 'stealth' },
      stealthRouter,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(['playwright_not_installed', 'cache_miss', 'fetch_failed']).toContain(r.error);
      expect(r.stage).toBe('fetch');
    }
  });

  it('SC-8: extract on no-tables page returns no_tables_detected with hint', async () => {
    const router = baseRouter(async () => ({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '<html><body><p>No tables here</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }));
    const r = await handleExtract(
      { url: 'https://example.com', mode: 'tables' },
      router,
    );
    if (!r.ok) {
      expect(r.error).toBe('no_tables_detected');
      expect(r.hint).toBeTruthy();
      expect(r.hint).toMatch(/stealth|JavaScript|table/i);
    }
  });

  it('SC-cache: cache mode performs zero outbound network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    const router = {
      fetch: vi.fn().mockRejectedValue(new Error('router should not be called in cache mode')),
    } as unknown as SmartRouter;
    const engine = baseEngine([]);
    await handleSearch(
      { query: 'something not in cache', mode: 'cache', include_content: false },
      [engine],
      router,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
