import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixturesDir = join(import.meta.dirname, '../../fixtures/extraction');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

vi.mock('../../../src/extraction/defuddle.js', () => ({
  defuddleExtract: vi.fn(),
}));

vi.mock('../../../src/extraction/readability.js', () => ({
  readabilityExtract: vi.fn(),
}));

import { defuddleExtract } from '../../../src/extraction/defuddle.js';
import { readabilityExtract } from '../../../src/extraction/readability.js';
import { extractContent, registerExtractor } from '../../../src/extraction/pipeline.js';
import type { ExtractionResult, Extractor } from '../../../src/types.js';

const mockDefuddle = vi.mocked(defuddleExtract);
const mockReadability = vi.mocked(readabilityExtract);

const ARTICLE_HTML = loadFixture('article.html');
const MINIMAL_HTML = loadFixture('minimal.html');
const BASE_URL = 'https://example.com/article';

function makeResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Test Title',
    markdown: 'Some markdown content that is long enough to pass thresholds.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractContent — site-specific extractor', () => {
  it('uses site-specific extractor when canHandle returns true', async () => {
    const siteResult = makeResult({ extractor: 'site-specific', title: 'Site Result' });
    const siteExtractor: Extractor = {
      name: 'test-extractor',
      canHandle: (url) => url.includes('example.com'),
      extract: () => siteResult,
    };
    registerExtractor(siteExtractor);

    const result = await extractContent(ARTICLE_HTML, BASE_URL);

    expect(result.extractor).toBe('site-specific');
    expect(result.title).toBe('Site Result');
    expect(mockDefuddle).not.toHaveBeenCalled();
    expect(mockReadability).not.toHaveBeenCalled();
  });
});

describe('extractContent — defuddle path', () => {
  it('uses defuddle result when defuddleExtract returns valid content', async () => {
    const defuddleResult = makeResult({ extractor: 'defuddle', title: 'Defuddle Title' });
    mockDefuddle.mockResolvedValue(defuddleResult);
    mockReadability.mockReturnValue(null);

    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page');

    expect(result.extractor).toBe('defuddle');
    expect(result.title).toBe('Defuddle Title');
    expect(mockReadability).not.toHaveBeenCalled();
  });
});

describe('extractContent — readability fallback', () => {
  it('falls back to readability when defuddle returns null', async () => {
    mockDefuddle.mockResolvedValue(null);
    const readabilityResult = makeResult({ extractor: 'readability', title: 'Readability Title' });
    mockReadability.mockReturnValue(readabilityResult);

    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page');

    expect(result.extractor).toBe('readability');
    expect(result.title).toBe('Readability Title');
  });
});

describe('extractContent — turndown fallback', () => {
  it('falls back to raw turndown when both defuddle and readability return null', async () => {
    mockDefuddle.mockResolvedValue(null);
    mockReadability.mockReturnValue(null);

    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page');

    expect(result.extractor).toBe('turndown');
    expect(result.markdown.length).toBeGreaterThan(0);
  });

  it('produces non-empty markdown from article HTML via turndown', async () => {
    mockDefuddle.mockResolvedValue(null);
    mockReadability.mockReturnValue(null);

    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page');

    expect(result.markdown).toContain('TypeScript');
  });
});

describe('extractContent — PDF content type', () => {
  it('returns a placeholder result for application/pdf content type', async () => {
    const result = await extractContent('%PDF-1.4 ...', BASE_URL, {
      contentType: 'application/pdf',
    });

    expect(result.extractor).toBe('turndown');
    expect(typeof result.markdown).toBe('string');
    expect(mockDefuddle).not.toHaveBeenCalled();
  });
});

describe('extractContent — max_chars truncation', () => {
  it('truncates markdown to maxChars when specified', async () => {
    mockDefuddle.mockResolvedValue(null);
    mockReadability.mockReturnValue(null);

    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page', { maxChars: 50 });

    expect(result.markdown.length).toBeLessThanOrEqual(50);
  });

  it('does not truncate when content is shorter than maxChars', async () => {
    const shortResult = makeResult({ extractor: 'defuddle', markdown: 'Short content.' });
    mockDefuddle.mockResolvedValue(shortResult);

    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page', { maxChars: 1000 });

    expect(result.markdown).toBe('Short content.');
  });
});

describe('extractContent — section targeting', () => {
  it('extracts the matching section when section option is provided', async () => {
    mockDefuddle.mockResolvedValue(null);
    mockReadability.mockReturnValue(null);

    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page', {
      section: 'Conclusion',
    });

    expect(result.markdown.toLowerCase()).toContain('conclusion');
  });

  it('returns full content when section is not found', async () => {
    mockDefuddle.mockResolvedValue(null);
    mockReadability.mockReturnValue(null);

    const noSectionResult = await extractContent(ARTICLE_HTML, 'https://other.com/page', {
      section: 'NonExistentSection12345',
    });
    const fullResult = await extractContent(ARTICLE_HTML, 'https://other.com/page');

    expect(noSectionResult.markdown.length).toBeGreaterThan(0);
    expect(noSectionResult.markdown).toBe(fullResult.markdown);
  });
});

describe('extractContent — links and images', () => {
  it('populates links and images extracted from markdown', async () => {
    mockDefuddle.mockResolvedValue(null);
    mockReadability.mockReturnValue(null);

    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page');

    expect(Array.isArray(result.links)).toBe(true);
    expect(Array.isArray(result.images)).toBe(true);
  });

  it('extracts image URLs from article HTML', async () => {
    mockDefuddle.mockResolvedValue(null);
    mockReadability.mockReturnValue(null);

    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page');

    const hasImages = result.images.length > 0;
    const hasLinks = result.links.length > 0;
    expect(hasImages || hasLinks).toBe(true);
  });
});

describe('extractContent — extractor field correctness', () => {
  it('returns extractor=defuddle when defuddle succeeds', async () => {
    mockDefuddle.mockResolvedValue(makeResult({ extractor: 'defuddle' }));
    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page');
    expect(result.extractor).toBe('defuddle');
  });

  it('returns extractor=readability when defuddle fails but readability succeeds', async () => {
    mockDefuddle.mockResolvedValue(null);
    mockReadability.mockReturnValue(makeResult({ extractor: 'readability' }));
    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page');
    expect(result.extractor).toBe('readability');
  });

  it('returns extractor=turndown when both fail', async () => {
    mockDefuddle.mockResolvedValue(null);
    mockReadability.mockReturnValue(null);
    const result = await extractContent(ARTICLE_HTML, 'https://other.com/page');
    expect(result.extractor).toBe('turndown');
  });

  it('returns extractor=site-specific when site extractor handles the URL', async () => {
    const specificExtractor: Extractor = {
      name: 'specific-extractor',
      canHandle: (url) => url.startsWith('https://specific.example.com'),
      extract: () => makeResult({ extractor: 'site-specific' }),
    };
    registerExtractor(specificExtractor);

    const result = await extractContent(ARTICLE_HTML, 'https://specific.example.com/page');
    expect(result.extractor).toBe('site-specific');
  });
});
