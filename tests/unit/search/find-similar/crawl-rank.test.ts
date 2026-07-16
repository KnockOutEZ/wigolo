import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SmartRouter } from '../../../../src/fetch/router.js';
import type { FindSimilarInput, RawFetchResult, ExtractionResult } from '../../../../src/types.js';

// Mock providers BEFORE importing the module under test
const mockExtract = vi.fn();
const mockEmbed = vi.fn();
let embedProviderShouldFail = false;

vi.mock('../../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: mockExtract,
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

vi.mock('../../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => {
    if (embedProviderShouldFail) throw new Error('embed unavailable');
    return {
      embed: mockEmbed,
      dim: 4,
      modelId: 'mock-embed',
    };
  }),
  _resetEmbedProviderForTest: vi.fn(),
}));

const { crawlRank } = await import('../../../../src/search/find-similar/crawl-rank.js');

function makeRaw(url: string, html: string, statusCode = 200): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html,
    contentType: 'text/html',
    statusCode,
    method: 'http',
    headers: {},
  };
}

function makeExtraction(title: string, markdown: string, links: string[] = []): ExtractionResult {
  return {
    title,
    markdown,
    metadata: {},
    links,
    images: [],
    extractor: 'defuddle',
  };
}

function makeRouter(map: Map<string, RawFetchResult | Error>): SmartRouter {
  return {
    fetch: vi.fn(async (url: string) => {
      const v = map.get(url);
      if (!v) throw new Error(`no mock for ${url}`);
      if (v instanceof Error) throw v;
      return v;
    }),
  } as unknown as SmartRouter;
}

function makeVec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

beforeEach(() => {
  vi.clearAllMocks();
  embedProviderShouldFail = false;
});

describe('crawlRank', () => {
  it('happy path: seed + 3 linked pages, ranked by cosine similarity', async () => {
    const seedUrl = 'https://example.com/seed';
    const links = [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ];

    const router = makeRouter(new Map([
      [seedUrl, makeRaw(seedUrl, '<html>seed</html>')],
      [links[0], makeRaw(links[0], '<html>a</html>')],
      [links[1], makeRaw(links[1], '<html>b</html>')],
      [links[2], makeRaw(links[2], '<html>c</html>')],
    ]));

    mockExtract
      .mockResolvedValueOnce(makeExtraction('Seed', 'seed body', links)) // seed
      .mockResolvedValueOnce(makeExtraction('Page A', 'a body'))
      .mockResolvedValueOnce(makeExtraction('Page B', 'b body'))
      .mockResolvedValueOnce(makeExtraction('Page C', 'c body'));

    // seed = [1,0,0,0]; A=high sim, B=mid, C=low
    mockEmbed.mockResolvedValueOnce([
      makeVec([1, 0, 0, 0]),       // seed
      makeVec([0.9, 0.1, 0, 0]),   // A — best
      makeVec([0.5, 0.5, 0, 0]),   // B
      makeVec([0, 1, 0, 0]),       // C — worst
    ]);

    const input: FindSimilarInput = { url: seedUrl, mode: 'crawl-rank' };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(3);
    expect(result.results[0].url).toBe(links[0]); // A first
    expect(result.results[1].url).toBe(links[1]); // B second
    expect(result.results[2].url).toBe(links[2]); // C last
    expect(result.results[0].relevance_score).toBeGreaterThan(result.results[1].relevance_score);
    expect(result.method).toBe('embedding');
    expect(result.embedding_available).toBe(true);
  });

  it('invalid seed URL returns error', async () => {
    const router = makeRouter(new Map());
    const input: FindSimilarInput = { url: 'not a url' };
    const result = await crawlRank('not a url', input, router);

    expect(result.error).toBe('Invalid seed URL');
    expect(result.results).toEqual([]);
  });

  it('seed fetch failure returns error', async () => {
    const seedUrl = 'https://example.com/seed';
    const router = makeRouter(new Map([[seedUrl, new Error('network down')]]));

    const input: FindSimilarInput = { url: seedUrl };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toMatch(/Seed fetch failed/);
    expect(result.results).toEqual([]);
  });

  it('non-2xx seed status returns error', async () => {
    const seedUrl = 'https://example.com/seed';
    const router = makeRouter(new Map([[seedUrl, makeRaw(seedUrl, '', 503)]]));

    const input: FindSimilarInput = { url: seedUrl };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toMatch(/Seed fetch failed: 503/);
    expect(result.results).toEqual([]);
  });

  it('no same-host links returns empty with error', async () => {
    const seedUrl = 'https://example.com/seed';
    const router = makeRouter(new Map([
      [seedUrl, makeRaw(seedUrl, '<html></html>')],
    ]));

    mockExtract.mockResolvedValueOnce(makeExtraction('Seed', 'body', [
      'https://other-host.com/x',
      'https://another.org/y',
    ]));

    const input: FindSimilarInput = { url: seedUrl };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toBe('No same-host links found from seed');
    expect(result.results).toEqual([]);
  });

  it('include_domains widens crawl to other hosts', async () => {
    const seedUrl = 'https://example.com/seed';
    const externalLink = 'https://docs.other.com/page';

    const router = makeRouter(new Map([
      [seedUrl, makeRaw(seedUrl, '<html></html>')],
      [externalLink, makeRaw(externalLink, '<html></html>')],
    ]));

    mockExtract
      .mockResolvedValueOnce(makeExtraction('Seed', 'seed body', [externalLink]))
      .mockResolvedValueOnce(makeExtraction('External', 'external body'));

    mockEmbed.mockResolvedValueOnce([
      makeVec([1, 0, 0, 0]),
      makeVec([0.8, 0.2, 0, 0]),
    ]);

    const input: FindSimilarInput = {
      url: seedUrl,
      include_domains: ['docs.other.com'],
    };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe(externalLink);
  });

  it('non-matching exclude_domains does not drop anything', async () => {
    const seedUrl = 'https://example.com/seed';
    const keep = 'https://example.com/keep';
    const drop = 'https://example.com/drop';

    const router = makeRouter(new Map([
      [seedUrl, makeRaw(seedUrl, '<html></html>')],
      [keep, makeRaw(keep, '<html></html>')],
      [drop, makeRaw(drop, '<html></html>')],
    ]));

    mockExtract
      .mockResolvedValueOnce(makeExtraction('Seed', 'body', [keep, drop]))
      .mockResolvedValueOnce(makeExtraction('Keep', 'keep body'))
      .mockResolvedValueOnce(makeExtraction('Drop', 'drop body'));

    mockEmbed.mockResolvedValueOnce([
      makeVec([1, 0, 0, 0]),
      makeVec([0.9, 0.1, 0, 0]),
      makeVec([0.7, 0.3, 0, 0]),
    ]);

    const input: FindSimilarInput = {
      url: seedUrl,
      exclude_domains: ['unrelated.com'],
    };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toBeUndefined();
    // Both keep + drop should be present (excludes don't match either)
    expect(result.results.map(r => r.url).sort()).toEqual([drop, keep].sort());
  });

  it('exclude_domains actually drops a matched host', async () => {
    const seedUrl = 'https://example.com/seed';
    const externalGood = 'https://docs.example.org/x';
    const externalBad = 'https://blocked.example.org/y';

    const router = makeRouter(new Map([
      [seedUrl, makeRaw(seedUrl, '<html></html>')],
      [externalGood, makeRaw(externalGood, '<html></html>')],
    ]));

    mockExtract
      .mockResolvedValueOnce(makeExtraction('Seed', 'body', [externalGood, externalBad]))
      .mockResolvedValueOnce(makeExtraction('Good', 'good body'));

    mockEmbed.mockResolvedValueOnce([
      makeVec([1, 0, 0, 0]),
      makeVec([0.9, 0.1, 0, 0]),
    ]);

    const input: FindSimilarInput = {
      url: seedUrl,
      include_domains: ['docs.example.org', 'blocked.example.org'],
      exclude_domains: ['blocked.example.org'],
    };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe(externalGood);
  });

  it('embedding unavailable returns degraded link-order results with error message', async () => {
    embedProviderShouldFail = true;
    const seedUrl = 'https://example.com/seed';
    const links = [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ];

    const router = makeRouter(new Map([
      [seedUrl, makeRaw(seedUrl, '<html></html>')],
    ]));

    mockExtract.mockResolvedValueOnce(makeExtraction('Seed', 'body', links));

    const input: FindSimilarInput = { url: seedUrl };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.embedding_available).toBe(false);
    expect(result.error).toMatch(/Embedding unavailable/);
    expect(result.results).toHaveLength(3);
    expect(result.results[0].url).toBe(links[0]);
    expect(result.results[0].relevance_score).toBeGreaterThan(result.results[2].relevance_score);
  });

  it('max_pages caps the crawl', async () => {
    const seedUrl = 'https://example.com/seed';
    const links = Array.from({ length: 25 }, (_, i) => `https://example.com/p${i}`);

    const fetchMap = new Map<string, RawFetchResult>();
    fetchMap.set(seedUrl, makeRaw(seedUrl, '<html></html>'));
    for (const l of links) fetchMap.set(l, makeRaw(l, '<html></html>'));

    const router = makeRouter(new Map(fetchMap));

    mockExtract.mockResolvedValueOnce(makeExtraction('Seed', 'seed body', links));
    for (let i = 0; i < 5; i++) {
      mockExtract.mockResolvedValueOnce(makeExtraction(`Page ${i}`, `body ${i}`));
    }

    // Cap to 5 pages
    mockEmbed.mockResolvedValueOnce([
      makeVec([1, 0, 0, 0]),
      makeVec([0.9, 0, 0, 0]),
      makeVec([0.8, 0, 0, 0]),
      makeVec([0.7, 0, 0, 0]),
      makeVec([0.6, 0, 0, 0]),
      makeVec([0.5, 0, 0, 0]),
    ]);

    const input: FindSimilarInput = { url: seedUrl, max_results: 10 };
    const result = await crawlRank(seedUrl, input, router, { maxPages: 5 });

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(5);
    expect(router.fetch).toHaveBeenCalledTimes(1 + 5); // seed + 5 pages
  });

  it('one linked page fetch failure: others still ranked', async () => {
    const seedUrl = 'https://example.com/seed';
    const links = [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ];

    const fetchMap = new Map<string, RawFetchResult | Error>();
    fetchMap.set(seedUrl, makeRaw(seedUrl, '<html></html>'));
    fetchMap.set(links[0], makeRaw(links[0], '<html></html>'));
    fetchMap.set(links[1], new Error('boom'));
    fetchMap.set(links[2], makeRaw(links[2], '<html></html>'));

    const router = makeRouter(fetchMap);

    mockExtract
      .mockResolvedValueOnce(makeExtraction('Seed', 'body', links))
      .mockResolvedValueOnce(makeExtraction('A', 'a body'))
      .mockResolvedValueOnce(makeExtraction('C', 'c body'));

    mockEmbed.mockResolvedValueOnce([
      makeVec([1, 0, 0, 0]),
      makeVec([0.9, 0.1, 0, 0]),
      makeVec([0.5, 0.5, 0, 0]),
    ]);

    const input: FindSimilarInput = { url: seedUrl };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(2);
    const urls = result.results.map(r => r.url).sort();
    expect(urls).toEqual([links[0], links[2]].sort());
  });

  it('max_results caps output below crawl count', async () => {
    const seedUrl = 'https://example.com/seed';
    const links = [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
    ];

    const fetchMap = new Map<string, RawFetchResult>();
    fetchMap.set(seedUrl, makeRaw(seedUrl, '<html></html>'));
    for (const l of links) fetchMap.set(l, makeRaw(l, '<html></html>'));
    const router = makeRouter(new Map(fetchMap));

    mockExtract.mockResolvedValueOnce(makeExtraction('Seed', 'body', links));
    for (let i = 0; i < links.length; i++) {
      mockExtract.mockResolvedValueOnce(makeExtraction(`P${i}`, `body ${i}`));
    }

    mockEmbed.mockResolvedValueOnce([
      makeVec([1, 0, 0, 0]),
      makeVec([0.9, 0, 0, 0]),
      makeVec([0.8, 0, 0, 0]),
      makeVec([0.7, 0, 0, 0]),
      makeVec([0.6, 0, 0, 0]),
    ]);

    const input: FindSimilarInput = { url: seedUrl, max_results: 2 };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(2);
  });

  it('dedupes duplicate links from extraction output', async () => {
    const seedUrl = 'https://example.com/seed';
    const link = 'https://example.com/a';

    const router = makeRouter(new Map([
      [seedUrl, makeRaw(seedUrl, '<html></html>')],
      [link, makeRaw(link, '<html></html>')],
    ]));

    mockExtract
      .mockResolvedValueOnce(makeExtraction('Seed', 'body', [link, link, `${link}#fragment`]))
      .mockResolvedValueOnce(makeExtraction('A', 'a body'));

    mockEmbed.mockResolvedValueOnce([
      makeVec([1, 0, 0, 0]),
      makeVec([0.9, 0.1, 0, 0]),
    ]);

    const input: FindSimilarInput = { url: seedUrl };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
  });

  it('refuses an SSRF seed (metadata target) before fetching', async () => {
    // WHY: crawl-rank fetches the seed URL raw via router.fetch — a
    // metadata/private seed must be refused by the guard, never fetched.
    const seedUrl = 'http://169.254.169.254/latest/meta-data/';
    const router = makeRouter(new Map());
    const input: FindSimilarInput = { url: seedUrl };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.results).toEqual([]);
    expect(result.error).toMatch(/link-local|metadata|blocked/i);
    expect(router.fetch).not.toHaveBeenCalled();
  });

  it('skips a discovered 1-hop link that fails the SSRF guard (others still ranked)', async () => {
    const seedUrl = 'https://example.com/seed';
    const good = 'https://example.com/a';
    // A same-host-shaped-but-private discovered link — guard must skip it.
    const bad = 'http://169.254.169.254/internal';

    const router = makeRouter(new Map([
      [seedUrl, makeRaw(seedUrl, '<html></html>')],
      [good, makeRaw(good, '<html></html>')],
    ]));

    mockExtract
      .mockResolvedValueOnce(makeExtraction('Seed', 'body', [good, bad]))
      .mockResolvedValueOnce(makeExtraction('Good', 'good body'));

    mockEmbed.mockResolvedValueOnce([
      makeVec([1, 0, 0, 0]),
      makeVec([0.9, 0.1, 0, 0]),
    ]);

    const input: FindSimilarInput = {
      url: seedUrl,
      include_domains: ['example.com', '169.254.169.254'],
    };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toBeUndefined();
    // Only the good link was fetched + ranked; the metadata link was skipped.
    expect(result.results.map(r => r.url)).toEqual([good]);
    expect(router.fetch).not.toHaveBeenCalledWith(bad, expect.anything());
  });

  it('drops invalid URLs from extracted links', async () => {
    const seedUrl = 'https://example.com/seed';
    const valid = 'https://example.com/ok';

    const router = makeRouter(new Map([
      [seedUrl, makeRaw(seedUrl, '<html></html>')],
      [valid, makeRaw(valid, '<html></html>')],
    ]));

    mockExtract
      .mockResolvedValueOnce(makeExtraction('Seed', 'body', ['javascript:void(0)', 'not a url', valid]))
      .mockResolvedValueOnce(makeExtraction('OK', 'ok body'));

    mockEmbed.mockResolvedValueOnce([
      makeVec([1, 0, 0, 0]),
      makeVec([0.9, 0.1, 0, 0]),
    ]);

    const input: FindSimilarInput = { url: seedUrl };
    const result = await crawlRank(seedUrl, input, router);

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe(valid);
  });
});
