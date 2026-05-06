import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleSearch } from '../../../src/tools/search.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { resetConfig } from '../../../src/config.js';
import * as rerankMod from '../../../src/search/rerank.js';
import type { RawSearchResult } from '../../../src/types.js';

describe('search mode validation', () => {
  beforeEach(() => { initDatabase(':memory:'); resetConfig(); });
  afterEach(() => { closeDatabase(); resetConfig(); });

  it('rejects unknown mode with a clear message', async () => {
    const router = { fetch: vi.fn() } as unknown as SmartRouter;
    await expect(
      handleSearch({ query: 'x', mode: 'turbo' as 'cache' }, [], router),
    ).rejects.toThrow(/Invalid mode/i);
  });
});

describe('search mode=fast', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false', WIGOLO_RERANKER: 'none' };
    initDatabase(':memory:');
    resetConfig();
  });
  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
    vi.restoreAllMocks();
  });

  it('uses exactly one engine and skips the reranker', async () => {
    const calls: string[] = [];
    const makeEngine = (name: string) => ({
      name,
      search: vi.fn().mockImplementation(async () => {
        calls.push(name);
        return [{
          title: name, url: `https://${name}.test/`, snippet: 's',
          relevance_score: 0.5, engine: name,
        }] satisfies RawSearchResult[];
      }),
    });
    const engines = [makeEngine('a'), makeEngine('b'), makeEngine('c')];
    const rerankSpy = vi.spyOn(rerankMod, 'rerankResults');
    const router = { fetch: vi.fn() } as unknown as SmartRouter;

    const out = await handleSearch(
      { query: 'hello', mode: 'fast', include_content: false },
      engines,
      router,
    );
    expect(new Set(calls).size).toBe(1);
    if (rerankSpy.mock.calls.length > 0) {
      const opts = rerankSpy.mock.calls[0][2] as { skip?: boolean } | undefined;
      expect(opts?.skip).toBe(true);
    }
    expect(out.results.length).toBeGreaterThan(0);
  });
});
