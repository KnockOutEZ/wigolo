import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSearch } from '../../../src/tools/search.js';
import type { SearchEngine, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock Title',
    markdown: '# Mock Content\n\nSome extracted content here.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

const fakeRouter = {} as SmartRouter;

const stubEngine: SearchEngine = {
  name: 'stub',
  async search(_query: string): Promise<RawSearchResult[]> {
    return [
      { title: 'React Hooks', url: 'https://react.dev/hooks', snippet: 'Hooks let you use state.', relevance_score: 0.95, engine: 'stub' },
      { title: 'Vue API', url: 'https://vuejs.org/api', snippet: 'The Composition API.', relevance_score: 0.85, engine: 'stub' },
    ];
  },
};

describe('handleSearch with format=context', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('returns context_text when format is context', async () => {
    const result = await handleSearch(
      { query: 'hooks', format: 'context', include_content: false },
      [stubEngine],
      fakeRouter,
    );

    expect(result.context_text).toBeDefined();
    expect(typeof result.context_text).toBe('string');
    expect(result.context_text).toContain('Source: React Hooks');
    expect(result.context_text).toContain('https://react.dev/hooks');
    expect(result.context_text).toContain('Hooks let you use state');
  });

  it('does not return context_text when format is full', async () => {
    const result = await handleSearch(
      { query: 'hooks', format: 'full', include_content: false },
      [stubEngine],
      fakeRouter,
    );

    expect(result.context_text).toBeUndefined();
  });

  it('does not return context_text when format is omitted', async () => {
    const result = await handleSearch(
      { query: 'hooks', include_content: false },
      [stubEngine],
      fakeRouter,
    );

    expect(result.context_text).toBeUndefined();
  });

  it('respects max_total_chars budget for context_text', async () => {
    const result = await handleSearch(
      { query: 'hooks', format: 'context', include_content: false, max_total_chars: 100 },
      [stubEngine],
      fakeRouter,
    );

    expect(result.context_text).toBeDefined();
    expect(result.context_text!.length).toBeLessThanOrEqual(100);
  });

  it('context_text contains all results when budget allows', async () => {
    const result = await handleSearch(
      { query: 'hooks', format: 'context', include_content: false, max_total_chars: 10000 },
      [stubEngine],
      fakeRouter,
    );

    expect(result.context_text).toContain('React Hooks');
    expect(result.context_text).toContain('Vue API');
  });

  it('still returns structured results alongside context_text', async () => {
    const result = await handleSearch(
      { query: 'hooks', format: 'context', include_content: false },
      [stubEngine],
      fakeRouter,
    );

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.context_text).toBeDefined();
  });
});
