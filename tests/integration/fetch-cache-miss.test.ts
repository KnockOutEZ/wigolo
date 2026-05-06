import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleFetch } from '../../src/tools/fetch.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';

describe('handleFetch mode:cache', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('returns explicit cache_miss StageError when URL not cached', async () => {
    const url = 'https://example.com/never-cached-' + Date.now();
    const __r_out = await handleFetch({ url, mode: 'cache' } as any, {} as any);;
    const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);
    expect((out as any).error).toBe('cache_miss');
    expect((out as any).error_reason).toMatch(/not in cache/i);
    expect((out as any).stage).toBe('fetch');
  });
});
