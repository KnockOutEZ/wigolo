import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchInput, RawSearchResult, FetchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock',
    markdown: 'a'.repeat(3000) + '\n\n' + 'b'.repeat(10000),
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

const { handleSearch } = await import('../../../src/tools/search.js');
const { handleFetch } = await import('../../../src/tools/fetch.js');

describe('max_content_chars — search', () => {
  const originalEnv = process.env;

  const engine = {
    name: 'mock',
    search: vi.fn().mockResolvedValue([
      { title: 'R1', url: 'https://e.com/1', snippet: 's1', relevance_score: 0.9, engine: 'mock' },
    ] satisfies RawSearchResult[]),
  };

  const router = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://e.com/1', finalUrl: 'https://e.com/1',
      html: '<html></html>', contentType: 'text/html', statusCode: 200,
      method: 'http' as const, headers: {},
    }),
  } as unknown as SmartRouter;

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false', WIGOLO_RERANKER: 'none' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('truncates result content to max_content_chars with marker', async () => {
    const input: SearchInput = { query: 'test', max_results: 1, max_content_chars: 3000 };
    const out = await handleSearch(input, [engine], router);
    const md = out.results[0].markdown_content ?? '';
    expect(md.length).toBeLessThanOrEqual(3000 + 30);
    expect(md.endsWith('[... content truncated]')).toBe(true);
  });

  it('leaves shorter content unchanged', async () => {
    const { extractContent } = await import('../../../src/extraction/pipeline.js');
    vi.mocked(extractContent).mockResolvedValueOnce({
      title: 'Short', markdown: 'short content', metadata: {}, links: [], images: [],
      extractor: 'defuddle' as const,
    });
    const input: SearchInput = { query: 'test', max_results: 1, max_content_chars: 3000 };
    const out = await handleSearch(input, [engine], router);
    expect(out.results[0].markdown_content).toBe('short content');
  });
});

describe('max_content_chars — fetch', () => {
  const originalEnv = process.env;

  const router = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://e.com/1', finalUrl: 'https://e.com/1',
      html: '<html></html>', contentType: 'text/html', statusCode: 200,
      method: 'http' as const, headers: {},
    }),
  } as unknown as SmartRouter;

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false', WIGOLO_RERANKER: 'none' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('truncates fetch markdown to max_content_chars', async () => {
    const { extractContent } = await import('../../../src/extraction/pipeline.js');
    vi.mocked(extractContent).mockResolvedValueOnce({
      title: 'Long', markdown: 'x'.repeat(10000), metadata: {}, links: [], images: [],
      extractor: 'defuddle' as const,
    });
    const input: FetchInput = { url: 'https://e.com/1', max_content_chars: 2000 };
    const out = await handleFetch(input, router);
    expect(out.markdown.length).toBeLessThanOrEqual(2000 + 30);
    expect(out.markdown.endsWith('[... content truncated]')).toBe(true);
  });
});
