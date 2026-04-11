import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { docsGenericExtractor } from '../../../../src/extraction/site-extractors/docs-generic.js';

const fixturesDir = join(import.meta.dirname, '../../../fixtures/site-extractors');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

const DOCUSAURUS_HTML = loadFixture('docusaurus-page.html');

describe('docsGenericExtractor.canHandle', () => {
  it('detects Docusaurus via .docs-sidebar class', () => {
    const html = '<html><body><nav class="docs-sidebar"></nav></body></html>';
    expect(docsGenericExtractor.canHandle('https://docs.example.com/intro', html)).toBe(true);
  });

  it('detects Docusaurus via data-docusaurus-page attribute', () => {
    const html = '<html data-docusaurus-page="true"><body></body></html>';
    expect(docsGenericExtractor.canHandle('https://docs.example.com/intro', html)).toBe(true);
  });

  it('detects MkDocs via .md-content class', () => {
    const html = '<html><body><div class="md-content"></div></body></html>';
    expect(docsGenericExtractor.canHandle('https://docs.example.com/intro', html)).toBe(true);
  });

  it('detects Sphinx via .document class', () => {
    const html = '<html><body><div class="document"></div></body></html>';
    expect(docsGenericExtractor.canHandle('https://docs.example.com/intro', html)).toBe(true);
  });

  it('detects Sphinx via .highlight inside .body', () => {
    const html = '<html><body><div class="body"><div class="highlight"></div></div></body></html>';
    expect(docsGenericExtractor.canHandle('https://docs.example.com/intro', html)).toBe(true);
  });

  it('detects GitBook via .page-body class', () => {
    const html = '<html><body><div class="page-body"></div></body></html>';
    expect(docsGenericExtractor.canHandle('https://docs.example.com/intro', html)).toBe(true);
  });

  it('returns false for unrecognised HTML', () => {
    const html = '<html><body><p>Just some content.</p></body></html>';
    expect(docsGenericExtractor.canHandle('https://example.com', html)).toBe(false);
  });

  it('returns false for GitHub HTML', () => {
    const html = '<html><body><div class="repository-content"></div></body></html>';
    expect(docsGenericExtractor.canHandle('https://github.com/foo/bar', html)).toBe(false);
  });
});

describe('docsGenericExtractor — Docusaurus extraction', () => {
  const url = 'https://docs.example.com/getting-started';

  it('returns a non-null result', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url);
    expect(result).not.toBeNull();
  });

  it('sets extractor to site-specific', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url)!;
    expect(result.extractor).toBe('site-specific');
  });

  it('extracts the page title', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url)!;
    expect(result.title).toContain('Getting Started');
  });

  it('extracts main content text', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url)!;
    expect(result.markdown).toContain('Welcome to My Docs');
  });

  it('preserves installation instructions', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url)!;
    expect(result.markdown).toContain('Prerequisites');
  });

  it('produces substantial markdown output', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url)!;
    expect(result.markdown.length).toBeGreaterThan(300);
  });
});

describe('docsGenericExtractor — code block preservation', () => {
  const url = 'https://docs.example.com/getting-started';

  it('preserves bash code block', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url)!;
    expect(result.markdown).toContain('npm install my-docs-package');
  });

  it('preserves typescript code block', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url)!;
    expect(result.markdown).toContain('createClient');
  });

  it('preserves code block content with api key reference', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url)!;
    expect(result.markdown).toContain('apiKey');
  });
});

describe('docsGenericExtractor — strip nav/TOC/version picker', () => {
  const url = 'https://docs.example.com/getting-started';

  it('strips sidebar navigation links', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url)!;
    expect(result.markdown).not.toContain('Introduction');
  });

  it('strips version picker content', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url)!;
    expect(result.markdown).not.toContain('1.5.0');
  });

  it('strips footer content', () => {
    const result = docsGenericExtractor.extract(DOCUSAURUS_HTML, url)!;
    expect(result.markdown).not.toContain('Built with Docusaurus');
  });
});

describe('docsGenericExtractor — MkDocs extraction', () => {
  const url = 'https://docs.example.com/page';
  const mkdocsHtml = `<!DOCTYPE html>
<html>
<head><title>MkDocs Page | My Site</title></head>
<body>
  <nav class="md-sidebar">Sidebar nav links</nav>
  <div class="md-content">
    <article>
      <h1>MkDocs Page</h1>
      <p>This is MkDocs content with useful information.</p>
      <pre><code class="language-python">def hello():
    print("Hello, world!")</code></pre>
    </article>
  </div>
  <footer>Footer content</footer>
</body>
</html>`;

  it('extracts MkDocs content', () => {
    const result = docsGenericExtractor.extract(mkdocsHtml, url)!;
    expect(result).not.toBeNull();
    expect(result.markdown).toContain('MkDocs content');
  });

  it('preserves MkDocs code blocks', () => {
    const result = docsGenericExtractor.extract(mkdocsHtml, url)!;
    expect(result.markdown).toContain('def hello');
  });
});

describe('docsGenericExtractor — Sphinx extraction', () => {
  const url = 'https://docs.example.com/sphinx-page';
  const sphinxHtml = `<!DOCTYPE html>
<html>
<head><title>Sphinx Documentation</title></head>
<body>
  <div class="sphinxsidebar">Sidebar</div>
  <div class="document">
    <div class="body">
      <div class="section" id="sphinx-section">
        <h1>Sphinx Section</h1>
        <p>This is Sphinx documentation content.</p>
        <div class="highlight">
          <pre>def sphinx_example():
    pass</pre>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

  it('extracts Sphinx content', () => {
    const result = docsGenericExtractor.extract(sphinxHtml, url)!;
    expect(result).not.toBeNull();
    expect(result.markdown).toContain('Sphinx documentation content');
  });

  it('preserves Sphinx code highlights', () => {
    const result = docsGenericExtractor.extract(sphinxHtml, url)!;
    expect(result.markdown).toContain('def sphinx');
  });
});

describe('docsGenericExtractor — GitBook extraction', () => {
  const url = 'https://docs.example.com/gitbook-page';
  const gitbookHtml = `<!DOCTYPE html>
<html>
<head><title>GitBook Page</title></head>
<body>
  <nav class="gitbook-sidebar">Navigation</nav>
  <div class="page-body">
    <h1>GitBook Page</h1>
    <p>This is GitBook documentation with important content.</p>
    <pre><code>const x = 42;</code></pre>
  </div>
</body>
</html>`;

  it('extracts GitBook content', () => {
    const result = docsGenericExtractor.extract(gitbookHtml, url)!;
    expect(result).not.toBeNull();
    expect(result.markdown).toContain('GitBook documentation');
  });

  it('preserves GitBook code blocks', () => {
    const result = docsGenericExtractor.extract(gitbookHtml, url)!;
    expect(result.markdown).toContain('const x = 42');
  });
});

describe('docsGenericExtractor — edge cases', () => {
  it('returns null for empty HTML', () => {
    const result = docsGenericExtractor.extract('', 'https://docs.example.com/page');
    expect(result).toBeNull();
  });

  it('returns null for HTML with no recognizable docs structure', () => {
    const result = docsGenericExtractor.extract(
      '<html><body><p>Nothing here</p></body></html>',
      'https://docs.example.com/page',
    );
    expect(result).toBeNull();
  });
});
