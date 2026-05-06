import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BackendStatus } from '../../../src/server/backend-status.js';
import { handleSearch } from '../../../src/tools/search.js';
import type { SearchEngine, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

const fakeRouter = {} as SmartRouter;

const stubEngine: SearchEngine = {
  name: 'stub',
  async search(): Promise<RawSearchResult[]> {
    return [{ title: 't', url: 'https://example.com', snippet: 's', relevance_score: 1, engine: 'stub' }];
  },
};

describe('handleSearch — warning injection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false' };
    resetConfig();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('attaches warning once when BackendStatus is unhealthy', async () => {
    const status = new BackendStatus();
    status.markUnhealthy('test reason');
    const __r_r1 = await handleSearch({ query: 'x', include_content: false }, [stubEngine], fakeRouter, status);;
    const r1 = __r_r1.ok ? __r_r1.data : ({ ...__r_r1 } as any);
    expect(r1.warning).toContain('test reason');
    const __r_r2 = await handleSearch({ query: 'y', include_content: false }, [stubEngine], fakeRouter, status);;
    const r2 = __r_r2.ok ? __r_r2.data : ({ ...__r_r2 } as any);
    expect(r2.warning).toBeUndefined();
  });

  it('does not attach warning when healthy', async () => {
    const status = new BackendStatus();
    status.markHealthy();
    const __r_r = await handleSearch({ query: 'x', include_content: false }, [stubEngine], fakeRouter, status);;
    const r = __r_r.ok ? __r_r.data : ({ ...__r_r } as any);
    expect(r.warning).toBeUndefined();
  });
});
