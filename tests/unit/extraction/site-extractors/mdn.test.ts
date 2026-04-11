import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mdnExtractor } from '../../../../src/extraction/site-extractors/mdn.js';

const fixturesDir = join(import.meta.dirname, '../../../fixtures/site-extractors');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

const MDN_HTML = loadFixture('mdn-article.html');

describe('mdnExtractor.canHandle', () => {
  it('matches developer.mozilla.org URLs', () => {
    expect(mdnExtractor.canHandle('https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map')).toBe(true);
  });

  it('matches any path under developer.mozilla.org', () => {
    expect(mdnExtractor.canHandle('https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API')).toBe(true);
  });

  it('does not match other mozilla.org subdomains', () => {
    expect(mdnExtractor.canHandle('https://www.mozilla.org/en-US/firefox/')).toBe(false);
  });

  it('does not match GitHub URLs', () => {
    expect(mdnExtractor.canHandle('https://github.com/mdn/content')).toBe(false);
  });

  it('does not match Stack Overflow URLs', () => {
    expect(mdnExtractor.canHandle('https://stackoverflow.com/questions/123')).toBe(false);
  });

  it('does not match URLs that merely mention mozilla in path', () => {
    expect(mdnExtractor.canHandle('https://example.com/mozilla/docs')).toBe(false);
  });
});

describe('mdnExtractor — article extraction', () => {
  const url = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map';

  it('returns a non-null result', () => {
    const result = mdnExtractor.extract(MDN_HTML, url);
    expect(result).not.toBeNull();
  });

  it('sets extractor to site-specific', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.extractor).toBe('site-specific');
  });

  it('extracts the article title', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.title).toContain('Array.prototype.map()');
  });

  it('preserves article content', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).toContain('callbackFn');
  });

  it('preserves description paragraph', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).toContain('new array populated with the results');
  });

  it('produces substantial markdown output', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown.length).toBeGreaterThan(300);
  });
});

describe('mdnExtractor — code examples', () => {
  const url = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map';

  it('preserves code examples', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).toContain('numbers.map');
  });

  it('preserves syntax example', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).toContain('callbackFn, thisArg');
  });

  it('preserves square root example', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).toContain('Math.sqrt');
  });

  it('preserves object reformat example', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).toContain('kvArray');
  });
});

describe('mdnExtractor — strip unwanted elements', () => {
  const url = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map';

  it('strips sidebar navigation links', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).not.toContain('forEach()');
  });

  it('strips header/breadcrumb content', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).not.toContain('Web technology for developers');
  });

  it('strips footer content', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).not.toContain('MDN Community');
  });

  it('strips metadata section', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).not.toContain('Last modified');
  });
});

describe('mdnExtractor — specification tables', () => {
  const url = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map';

  it('preserves specification table content', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).toContain('ECMAScript Language Specification');
  });

  it('preserves specification link text', () => {
    const result = mdnExtractor.extract(MDN_HTML, url)!;
    expect(result.markdown).toContain('Array.prototype.map');
  });
});

describe('mdnExtractor — edge cases', () => {
  it('returns null for empty HTML', () => {
    const result = mdnExtractor.extract('', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API');
    expect(result).toBeNull();
  });

  it('returns null for HTML with no recognizable MDN structure', () => {
    const result = mdnExtractor.extract(
      '<html><body><p>Nothing here</p></body></html>',
      'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    );
    expect(result).toBeNull();
  });
});
