import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { cacheContent } from '../../../src/cache/store.js';
import { handleCache } from '../../../src/tools/cache.js';
import { resetConfig } from '../../../src/config.js';
import { DEFAULT_CHECK_CHANGES_LIMIT } from '../../../src/cache/output-budget.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: vi.fn(async () => ({
      title: 'Test Page',
      markdown: '# Test\n\nUnchanged content.',
      metadata: {},
      links: [],
      images: [],
      extractor: 'defuddle' as const,
    })),
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

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
    markdown: '# Test\n\nSome content.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
    ...overrides,
  };
}

/** Counts re-fetches so the row cap can be checked as a NETWORK bound. */
function countingRouter() {
  const fetch = vi.fn(async (url: string) => makeRaw(url));
  return { fetch } as never as { fetch: ReturnType<typeof vi.fn> };
}

function seed(count: number): void {
  for (let i = 0; i < count; i++) {
    cacheContent(
      makeRaw(`https://example.com/page-${String(i).padStart(4, '0')}`),
      makeExtraction({ title: `Page ${i}`, markdown: `# Page ${i}\n\nBody ${i}.` }),
    );
  }
}

// These run against a REAL database on purpose. The bug this file exists for was
// invisible to a mocked store: the tool passed no limit, the store quietly
// applied its own default of 100, and a mock returning 250 rows for that call
// asserted against a page the real store cannot produce. A mock that can return
// what the dependency never returns will validate a cap that does not exist.
describe('cache check_changes — row cap against a real store', () => {
  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('reports the true number of matching entries, not the size of the page it got', async () => {
    seed(250);
    const router = countingRouter();

    const result = await handleCache({ check_changes: true, url_pattern: '*' }, router as never);

    expect(result.changes).toHaveLength(DEFAULT_CHECK_CHANGES_LIMIT);
    // The cap is a network bound too, not only an output bound.
    expect(router.fetch).toHaveBeenCalledTimes(DEFAULT_CHECK_CHANGES_LIMIT);
    expect(result.changes_truncation).toEqual({
      matched: 250,
      checked: DEFAULT_CHECK_CHANGES_LIMIT,
      hint: expect.stringContaining('250'),
    });
  });

  // The store applies its own default when no limit reaches it, so a caller
  // asking for more than that got silently held to it with nothing said.
  it('honours a limit larger than the store default', async () => {
    seed(250);
    const router = countingRouter();

    const result = await handleCache(
      { check_changes: true, url_pattern: '*', limit: 200 },
      router as never,
    );

    expect(result.changes).toHaveLength(200);
    expect(router.fetch).toHaveBeenCalledTimes(200);
    expect(result.changes_truncation).toEqual({
      matched: 250,
      checked: 200,
      hint: expect.stringContaining('250'),
    });
  });

  it('reports the true total even when the caller asks for fewer than the default', async () => {
    seed(250);

    const result = await handleCache(
      { check_changes: true, url_pattern: '*', limit: 50 },
      countingRouter() as never,
    );

    expect(result.changes).toHaveLength(50);
    // Not 100 — the store's page size must not be mistaken for the match count.
    expect(result.changes_truncation!.matched).toBe(250);
  });

  // NEGATIVE — an ordinary change check is well under the cap and must not be
  // told anything was held back.
  it('reports no cap when every matching entry was checked', async () => {
    seed(8);
    const router = countingRouter();

    const result = await handleCache({ check_changes: true, url_pattern: '*' }, router as never);

    expect(result.changes).toHaveLength(8);
    expect(router.fetch).toHaveBeenCalledTimes(8);
    expect(result.changes_truncation).toBeUndefined();
  });

  // Boundary: exactly at the cap there is nothing left over, so nothing to report.
  it('reports no cap when the matches land exactly on the cap', async () => {
    seed(DEFAULT_CHECK_CHANGES_LIMIT);

    const result = await handleCache(
      { check_changes: true, url_pattern: '*' },
      countingRouter() as never,
    );

    expect(result.changes).toHaveLength(DEFAULT_CHECK_CHANGES_LIMIT);
    expect(result.changes_truncation).toBeUndefined();
  });

  it('counts only what the filter matches, not the whole cache', async () => {
    seed(150);
    for (let i = 0; i < 120; i++) {
      cacheContent(
        makeRaw(`https://other.test/doc-${i}`),
        makeExtraction({ title: `Other ${i}`, markdown: `# Other ${i}` }),
      );
    }

    const result = await handleCache(
      { check_changes: true, url_pattern: '*example.com*' },
      countingRouter() as never,
    );

    expect(result.changes_truncation!.matched).toBe(150);
  });
});
