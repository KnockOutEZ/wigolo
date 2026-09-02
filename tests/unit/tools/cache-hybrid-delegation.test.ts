import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/cache/hybrid-search.js', () => ({
  runHybridSearch: vi.fn(),
  runFtsCacheSearch: vi.fn(),
}));
vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { runHybridSearch } from '../../../src/cache/hybrid-search.js';
import { handleCache } from '../../../src/tools/cache.js';

describe('cache tool hybrid delegation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to the cache module and discards its method field', async () => {
    vi.mocked(runHybridSearch).mockResolvedValue({
      method: 'fts',
      results: [{
        url: 'https://example.com/result',
        title: 'Result',
        markdown: 'small body',
        fetched_at: '2026-09-03 00:00:00',
        source: 'cache',
        trusted: false,
      }],
    });

    const output = await handleCache({
      query: 'needle',
      mode: 'hybrid',
      url_pattern: '*example.com*',
      since: '2026-09-01',
      limit: 7,
    });

    expect(runHybridSearch).toHaveBeenCalledWith({
      query: 'needle',
      urlPattern: '*example.com*',
      since: '2026-09-01',
      limit: 7,
    });
    expect(output).toEqual({
      results: [{
        url: 'https://example.com/result',
        title: 'Result',
        markdown: 'small body',
        fetched_at: '2026-09-03 00:00:00',
        source: 'cache',
        trusted: false,
      }],
    });
    expect(output).not.toHaveProperty('method');
  });
});
