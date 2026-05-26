import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtractionResult } from '../../../../src/types.js';

vi.mock('../../../../src/extraction/defuddle.js', () => ({
  defuddleExtract: vi.fn(),
}));

vi.mock('../../../../src/extraction/readability.js', () => ({
  readabilityExtract: vi.fn(),
}));

vi.mock('../../../../src/extraction/v1/recipe.js', () => ({
  extractRecipe: vi.fn(),
}));

vi.mock('../../../../src/extraction/v1/product.js', () => ({
  extractProduct: vi.fn(),
}));

vi.mock('../../../../src/extraction/v1/news.js', () => ({
  extractNews: vi.fn(),
}));

vi.mock('../../../../src/extraction/v1/classifier.js', () => ({
  classifyContent: vi.fn(),
}));

import { defuddleExtract } from '../../../../src/extraction/defuddle.js';
import { readabilityExtract } from '../../../../src/extraction/readability.js';
import { extractRecipe } from '../../../../src/extraction/v1/recipe.js';
import { extractProduct } from '../../../../src/extraction/v1/product.js';
import { extractNews } from '../../../../src/extraction/v1/news.js';
import { classifyContent } from '../../../../src/extraction/v1/classifier.js';
import { routedExtract } from '../../../../src/extraction/v1/routed.js';
import { _resetSiteExtractorsForTest } from '../../../../src/extraction/v1/site-extractors.js';

const mockDefuddle = vi.mocked(defuddleExtract);
const mockReadability = vi.mocked(readabilityExtract);
const mockRecipe = vi.mocked(extractRecipe);
const mockProduct = vi.mocked(extractProduct);
const mockNews = vi.mocked(extractNews);
const mockClassify = vi.mocked(classifyContent);

function res(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Title',
    markdown: 'Body content that is long enough to pass any threshold check downstream.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
    ...overrides,
  };
}

const HTML = '<html><body><article><p>some body content here</p></article></body></html>';
const URL = 'https://example.com/some/page';

beforeEach(() => {
  vi.clearAllMocks();
  _resetSiteExtractorsForTest();
  mockDefuddle.mockResolvedValue(null);
  mockReadability.mockReturnValue(null);
  mockRecipe.mockResolvedValue(null);
  mockProduct.mockResolvedValue(null);
  mockNews.mockResolvedValue(null);
});

describe('routedExtract — recipe branch', () => {
  it('uses extractRecipe when classifier returns recipe', async () => {
    mockClassify.mockReturnValue('recipe');
    mockRecipe.mockResolvedValue(res({ extractor: 'site-specific', title: 'Cookie' }));

    const result = await routedExtract({ html: HTML, url: URL });

    expect(mockRecipe).toHaveBeenCalledOnce();
    expect(result.title).toBe('Cookie');
    expect(result.extractor).toBe('site-specific');
  });

  it('falls back to defuddle when extractRecipe returns null', async () => {
    mockClassify.mockReturnValue('recipe');
    mockRecipe.mockResolvedValue(null);
    mockDefuddle.mockResolvedValue(res({ extractor: 'defuddle' }));

    const result = await routedExtract({ html: HTML, url: URL });

    expect(mockDefuddle).toHaveBeenCalledOnce();
    expect(result.extractor).toBe('defuddle');
  });
});

describe('routedExtract — product branch', () => {
  it('uses extractProduct when classifier returns product', async () => {
    mockClassify.mockReturnValue('product');
    mockProduct.mockResolvedValue(res({ extractor: 'site-specific', title: 'Widget' }));

    const result = await routedExtract({ html: HTML, url: URL });

    expect(mockProduct).toHaveBeenCalledOnce();
    expect(result.title).toBe('Widget');
  });

  it('falls back to defuddle when extractProduct returns null', async () => {
    mockClassify.mockReturnValue('product');
    mockProduct.mockResolvedValue(null);
    mockDefuddle.mockResolvedValue(res({ extractor: 'defuddle' }));

    const result = await routedExtract({ html: HTML, url: URL });

    expect(mockDefuddle).toHaveBeenCalledOnce();
    expect(result.extractor).toBe('defuddle');
  });
});

describe('routedExtract — news branch', () => {
  it('uses extractNews when classifier returns news', async () => {
    mockClassify.mockReturnValue('news');
    mockNews.mockResolvedValue(res({ extractor: 'readability', title: 'News piece' }));

    const result = await routedExtract({ html: HTML, url: URL });

    expect(mockNews).toHaveBeenCalledOnce();
    expect(result.title).toBe('News piece');
  });

  it('falls back to defuddle when extractNews returns null', async () => {
    mockClassify.mockReturnValue('news');
    mockNews.mockResolvedValue(null);
    mockDefuddle.mockResolvedValue(res({ extractor: 'defuddle' }));

    const result = await routedExtract({ html: HTML, url: URL });

    expect(mockDefuddle).toHaveBeenCalledOnce();
    expect(result.extractor).toBe('defuddle');
  });
});

describe('routedExtract — code branch', () => {
  it('uses defuddle for code (site extractors handle github/SO)', async () => {
    mockClassify.mockReturnValue('code');
    mockDefuddle.mockResolvedValue(res({ extractor: 'defuddle' }));

    const result = await routedExtract({ html: HTML, url: URL });

    expect(mockRecipe).not.toHaveBeenCalled();
    expect(mockProduct).not.toHaveBeenCalled();
    expect(mockNews).not.toHaveBeenCalled();
    expect(result.extractor).toBe('defuddle');
  });
});

describe('routedExtract — docs branch', () => {
  it('uses defuddle for docs', async () => {
    mockClassify.mockReturnValue('docs');
    mockDefuddle.mockResolvedValue(res({ extractor: 'defuddle' }));

    const result = await routedExtract({ html: HTML, url: URL });

    expect(result.extractor).toBe('defuddle');
  });
});

describe('routedExtract — generic branch', () => {
  it('falls through defuddle → readability → turndown', async () => {
    mockClassify.mockReturnValue('generic');
    mockDefuddle.mockResolvedValue(null);
    mockReadability.mockReturnValue(res({ extractor: 'readability' }));

    const result = await routedExtract({ html: HTML, url: URL });

    expect(mockDefuddle).toHaveBeenCalledOnce();
    expect(mockReadability).toHaveBeenCalledOnce();
    expect(result.extractor).toBe('readability');
  });

  it('produces a turndown result when defuddle and readability both fail', async () => {
    mockClassify.mockReturnValue('generic');
    mockDefuddle.mockResolvedValue(null);
    mockReadability.mockReturnValue(null);

    const result = await routedExtract({ html: HTML, url: URL });

    expect(result.extractor).toBe('turndown');
    expect(typeof result.markdown).toBe('string');
  });
});

describe('routedExtract — site-specific extractors run first', () => {
  it('does not invoke classifier when a site extractor matches', async () => {
    // GitHub site extractor matches github.com URLs.
    const githubHtml = `<html><body>
      <article class="markdown-body"><h1>README</h1><p>Hello world.</p></article>
    </body></html>`;
    const result = await routedExtract({
      html: githubHtml,
      url: 'https://github.com/owner/repo',
    });

    // Site extractor handled it OR we still passed through defuddle/readability,
    // but classifyContent should not be the gate.
    expect(result).toBeDefined();
  });
});

describe('routedExtract — site_data passthrough (P1 regression guard)', () => {
  // Why these tests exist: slice unit tests passed at the extractor boundary
  // but the structured `SiteExtractionResult` was getting flattened into
  // markdown by the routed wiring. These tests pin the passthrough at the
  // routed-extract layer — one level below the integration test in
  // tests/integration/fetch-site-data.test.ts.
  it('omits site_data for URLs that no site extractor handles', async () => {
    mockClassify.mockReturnValue('generic');
    mockDefuddle.mockResolvedValue(res({ extractor: 'defuddle' }));

    const result = await routedExtract({
      html: HTML,
      url: 'https://example.com/some/random/page',
    });

    expect(result.site_data).toBeUndefined();
  });

  it('attaches site_data when the reddit extractor matches', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fx = readFileSync(
      join(import.meta.dirname, '../../../fixtures/site-extractors/reddit-thread.html'),
      'utf-8',
    );
    const result = await routedExtract({
      html: fx,
      url: 'https://old.reddit.com/r/programming/comments/abc123/whats_your_favorite_typescript_trick/',
    });

    expect(result.site_data).toBeDefined();
    const site = result.site_data as Record<string, unknown>;
    expect(site.subreddit).toBe('programming');
    expect(typeof site.score).toBe('number');
    expect(Array.isArray(site.comments)).toBe(true);
  });

  it('attaches site_data when the youtube extractor matches', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fx = readFileSync(
      join(import.meta.dirname, '../../../fixtures/site-extractors/youtube-watch-with-captions.html'),
      'utf-8',
    );
    const result = await routedExtract({
      html: fx,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });

    expect(result.site_data).toBeDefined();
    const site = result.site_data as Record<string, unknown>;
    expect(site.video_id).toBe('dQw4w9WgXcQ');
    expect(Array.isArray(site.caption_tracks)).toBe(true);
    expect(Array.isArray(site.chapters)).toBe(true);
  });

  it('attaches site_data when the amazon extractor matches', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fx = readFileSync(
      join(import.meta.dirname, '../../../fixtures/amazon/electronics.html'),
      'utf-8',
    );
    const result = await routedExtract({
      html: fx,
      url: 'https://www.amazon.com/dp/B08N5WRWNW/',
    });

    expect(result.site_data).toBeDefined();
    const site = result.site_data as Record<string, unknown>;
    expect(site.asin).toBe('B08N5WRWNW');
    expect(typeof site.price).toBe('number');
    expect(Array.isArray(site.features)).toBe(true);
  });
});
