import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { cacheContent } from '../../../src/cache/store.js';
import { handleCache } from '../../../src/tools/cache.js';
import { resetConfig } from '../../../src/config.js';
import { countTokens } from '../../../src/search/tokens.js';
import { DEFAULT_CACHE_MAX_TOKENS_OUT } from '../../../src/cache/output-budget.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

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
    markdown: '# Test\n\nSome test content.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
    ...overrides,
  };
}

// A body roughly the size of a real cached documentation page. The live cache
// this bug was found in holds pages up to 186,640 chars; the p90 is ~30,000.
function bigBody(chars: number): string {
  const para =
    'The connection pool keeps a bounded set of open sockets so that a request ' +
    'does not pay the handshake cost every time it needs to talk to the upstream. ' +
    'When the pool is exhausted the caller waits, and that wait is what shows up ' +
    'as latency in the trace.\n\n';
  return para.repeat(Math.ceil(chars / para.length)).slice(0, chars);
}

function seedPages(count: number, charsEach: number): void {
  for (let i = 0; i < count; i++) {
    cacheContent(
      makeRaw(`https://example.com/pooling-${i}`),
      makeExtraction({
        title: `Pooling guide ${i}`,
        markdown: `# Pooling guide ${i}\n\n${bigBody(charsEach)}`,
      }),
    );
  }
}

describe('cache tool — output byte budget (F4)', () => {
  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  // THE REGRESSION. A live dogfood call returned 171,751 characters in one
  // response and had to be spilled to a file to be readable at all. `limit`
  // caps rows, not bytes, so five ordinary cached pages are enough to do it.
  it('bounds a response that would otherwise return well over 150,000 characters', async () => {
    seedPages(5, 35_000); // ~175,000 chars of body across the default 5 rows

    const result = await handleCache({ url_pattern: '*example.com*' });

    expect(result.results).toBeDefined();
    const serialized = JSON.stringify(result);
    // Without a default budget this is ~175,000. With one it must be bounded by
    // the budget, not by how much happens to be in the cache.
    expect(serialized.length).toBeLessThan(100_000);
    const bodyTokens = result.results!.reduce((n, r) => n + countTokens(r.markdown), 0);
    expect(bodyTokens).toBeLessThanOrEqual(DEFAULT_CACHE_MAX_TOKENS_OUT);
  });

  it('says it truncated, how much it dropped, and how to get the rest', async () => {
    seedPages(5, 35_000);

    const result = await handleCache({ url_pattern: '*example.com*' });

    expect(result.truncation).toBeDefined();
    const t = result.truncation!;
    expect(t.budget_tokens).toBe(DEFAULT_CACHE_MAX_TOKENS_OUT);
    expect(t.original_chars).toBeGreaterThan(150_000);
    expect(t.dropped_chars).toBe(t.original_chars - t.returned_chars);
    expect(t.dropped_chars).toBeGreaterThan(0);
    expect(t.results_truncated + t.results_omitted).toBeGreaterThan(0);
    // The caller has to be able to act on this without reading our source.
    expect(t.hint).toMatch(/max_tokens_out/);
    expect(t.hint).toMatch(/fetch/);
  });

  // NEGATIVE. The default must not be so tight that ordinary cache checks start
  // losing content. The live corpus median cached page is ~1,400 tokens, so a
  // default-limit query over median pages is ~7,000 tokens — it must survive.
  it('leaves an ordinary cache result byte-identical and reports no truncation', async () => {
    const bodies: string[] = [];
    for (let i = 0; i < 5; i++) {
      const markdown = `# Pooling guide ${i}\n\n${bigBody(5_400)}`; // corpus median
      bodies.push(markdown);
      cacheContent(
        makeRaw(`https://example.com/pooling-${i}`),
        makeExtraction({ title: `Pooling guide ${i}`, markdown }),
      );
    }

    const result = await handleCache({ url_pattern: '*example.com*' });

    expect(result.truncation).toBeUndefined();
    expect(result.results).toHaveLength(5);
    for (const r of result.results!) {
      expect(bodies).toContain(r.markdown);
      expect(r.truncated).toBeUndefined();
    }
  });

  it('lets an explicit max_tokens_out override the default in both directions', async () => {
    seedPages(5, 35_000);

    const tight = await handleCache({ url_pattern: '*example.com*', max_tokens_out: 500 });
    const tightTokens = tight.results!.reduce((n, r) => n + countTokens(r.markdown), 0);
    expect(tightTokens).toBeLessThanOrEqual(500);
    expect(tight.truncation!.budget_tokens).toBe(500);

    const wide = await handleCache({ url_pattern: '*example.com*', max_tokens_out: 200_000 });
    const wideChars = wide.results!.reduce((n, r) => n + r.markdown.length, 0);
    expect(wideChars).toBeGreaterThan(150_000);
    expect(wide.truncation).toBeUndefined();
  });

  // `limit` caps ROWS and is applied by the query; the byte budget then caps the
  // bodies of whatever rows survived. Row cap first, byte cap second.
  it('applies the row limit first and the byte budget second', async () => {
    seedPages(10, 50_000);

    const result = await handleCache({ url_pattern: '*example.com*', limit: 2 });

    expect(result.results).toHaveLength(2);
    // The budget saw only the 2 rows the limit kept — not all 10 (500,000 chars).
    expect(result.truncation!.original_chars).toBeGreaterThan(90_000);
    expect(result.truncation!.original_chars).toBeLessThan(150_000);
    const bodyTokens = result.results!.reduce((n, r) => n + countTokens(r.markdown), 0);
    expect(bodyTokens).toBeLessThanOrEqual(DEFAULT_CACHE_MAX_TOKENS_OUT);
  });

  // An emptied body reads exactly like "this cached page has nothing in it".
  // Every row the budget touched has to say so on the row itself.
  it('labels each row the budget touched so an omitted body is not read as an empty page', async () => {
    seedPages(5, 35_000);

    const result = await handleCache({ url_pattern: '*example.com*' });

    const labelled = result.results!.filter((r) => r.truncated !== undefined);
    expect(labelled.length).toBeGreaterThan(0);
    for (const r of result.results!) {
      if (r.markdown === '') expect(r.truncated).toBe('omitted');
      if (r.truncated === 'partial') expect(r.markdown.length).toBeGreaterThan(0);
    }
  });
});
