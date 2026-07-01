import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { cacheContent } from '../../src/cache/store.js';
import { handleCache } from '../../src/tools/cache.js';
import { resetConfig } from '../../src/config.js';
import type { RawFetchResult, ExtractionResult } from '../../src/types.js';

function makeRaw(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html><body>content</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Test Page',
    markdown: '# Test\n\nSome test content about typescript and other things.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
    ...overrides,
  };
}

// cache.query default limit should be 5 to keep response within token caps.
describe('cache.query — H3 default limit', () => {
  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('returns at most 5 results when no limit is provided', async () => {
    // Seed 12 cache entries that all match the query.
    for (let i = 0; i < 12; i++) {
      cacheContent(
        makeRaw(`https://example.com/typescript-${i}`),
        makeExtraction({
          title: `TypeScript Guide ${i}`,
          markdown: `# TypeScript guide ${i}\n\nLearn TypeScript section ${i}.`,
        }),
      );
    }

    const result = await handleCache({ query: 'typescript' });

    expect(result.results).toBeDefined();
    expect(result.results!.length).toBeLessThanOrEqual(5);
  });

  it('honors an explicit limit when caller passes one', async () => {
    for (let i = 0; i < 12; i++) {
      cacheContent(
        makeRaw(`https://example.com/typescript-${i}`),
        makeExtraction({
          title: `TypeScript Guide ${i}`,
          markdown: `# TypeScript guide ${i}\n\nLearn TypeScript section ${i}.`,
        }),
      );
    }

    const result = await handleCache({ query: 'typescript', limit: 8 });

    expect(result.results).toBeDefined();
    expect(result.results!.length).toBe(8);
  });
});
