import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSearch } from '../../src/tools/search.js';
import type { SearchEngine } from '../../src/types.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

vi.mock('../../src/search/multi-query.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return {
    ...real,
    fanOutSearch: vi.fn(async () => ({
      results: [
        { url: 'https://example.com/a', title: 'PostgreSQL replication', snippet: 'WAL streaming guide', engine: 'bing' },
        { url: 'https://baidu.com/x', title: '人工智能教程', snippet: '本文介绍人工智能基础', engine: 'bing' },
        { url: 'https://baidu.com/y', title: '深度学习', snippet: '神经网络的实现细节', engine: 'bing' },
      ],
      enginesUsed: ['bing'],
      errors: [],
    })),
  };
});

describe('handleSearch language filter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false', WIGOLO_RERANKER: 'none' };
    resetConfig();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('drops non-English bing batch and surfaces a warning', async () => {
    const stubEngine: SearchEngine = {
      name: 'bing',
      search: async () => [],
    };
    const stubRouter = {
      fetch: async () => { throw new Error('not used'); },
    } as unknown as Parameters<typeof handleSearch>[2];

    const __r_out = await handleSearch(
      { query: ['postgres replication'], format: undefined, include_content: false },
      [stubEngine],
      stubRouter,
    );;
    const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);
    const signal = `${out.warning ?? ''} ${out.error ?? ''} ${out.error_reason ?? ''}`;
    expect(signal).toMatch(/engine_language_mismatch|engine_batch_dropped|no.results/i);
    for (const r of out.results ?? []) expect(r.url).not.toContain('baidu.com');
  });
});
