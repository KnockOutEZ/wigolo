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

  it('extracts modern MDN pages that use <main id="content"> without the .main-page-content wrapper', () => {
    // Yari rolled out new doc layouts where the article wrapper class changed.
    // Bench saw nav-chrome leak because the extractor fell through to a bare
    // <article> that wasn't the doc body. main#content is the canonical
    // post-redesign container; assert it succeeds.
    const html = `<html>
      <head>
        <title>Array.prototype.map() - JavaScript | MDN</title>
        <meta property="og:title" content="Array.prototype.map() - JavaScript">
      </head>
      <body>
        <header>site header chrome</header>
        <main id="content">
          <h1>Array.prototype.map()</h1>
          <aside class="sidebar"><ul><li>related: forEach()</li></ul></aside>
          <p>The map() method creates a new array populated with the results of calling a provided function on every element in the calling array.</p>
          <pre><code>numbers.map(x =&gt; x * 2)</code></pre>
        </main>
        <footer>MDN Community</footer>
      </body>
    </html>`;
    const result = mdnExtractor.extract(html, 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map');
    expect(result).not.toBeNull();
    // h1 wins over og:title when present in the article.
    expect(result!.title).toBe('Array.prototype.map()');
    expect(result!.markdown).toContain('new array populated');
    expect(result!.markdown).not.toContain('related: forEach');
    expect(result!.markdown).not.toContain('MDN Community');
  });

  it('falls back to og:title when no h1 is present in the article', () => {
    const html = `<html>
      <head>
        <title>fetch() - Web APIs | MDN</title>
        <meta property="og:title" content="fetch() global function">
      </head>
      <body>
        <main id="content">
          <p>The fetch() method starts the process of fetching a resource from the network.</p>
        </main>
      </body>
    </html>`;
    const result = mdnExtractor.extract(html, 'https://developer.mozilla.org/en-US/docs/Web/API/fetch');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('fetch() global function');
  });

  it('strips inline aside/sidebar elements with any [class*="sidebar"] suffix', () => {
    const html = `<html><body>
      <article class="main-page-content">
        <h1>Title</h1>
        <p>Real article content.</p>
        <aside class="page-sidebar">unrelated nav</aside>
        <div class="left-sidebar">more nav</div>
      </article>
    </body></html>`;
    const result = mdnExtractor.extract(html, 'https://developer.mozilla.org/en-US/docs/Foo');
    expect(result).not.toBeNull();
    expect(result!.markdown).toContain('Real article content.');
    expect(result!.markdown).not.toContain('unrelated nav');
    expect(result!.markdown).not.toContain('more nav');
  });
});
