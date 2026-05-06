import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSearch } from '../../src/tools/search.js';
import type { SearchEngine } from '../../src/types.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

vi.mock('../../src/search/multi-query.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return {
    ...real,
    fanOutSearch: vi.fn(async () => ({ results: [], enginesUsed: ['bing'], errors: [] })),
  };
});

describe('handleSearch format:answer with zero results', () => {
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

  it('returns an explicit StageError, not a silent empty', async () => {
    const stubEngine: SearchEngine = {
      name: 'bing',
      search: async () => [],
    };
    const stubRouter = {
      fetch: async () => { throw new Error('not used'); },
    } as unknown as Parameters<typeof handleSearch>[2];

    const __r_out = await handleSearch(
      { query: 'this will not match anything zzz', format: 'answer' },
      [stubEngine],
      stubRouter,
    );;
    const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);
    expect((out as Record<string, unknown>).error).toBe('no_content');
    expect((out as Record<string, unknown>).error_reason).toMatch(/no sources/i);
    expect((out as Record<string, unknown>).stage).toBe('synthesize');
    expect(out.results).toEqual([]);
  });
});
