import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  BOILERPLATE_TEXT_EQUALITY,
  BOILERPLATE_TEXT_PATTERNS,
  BOILERPLATE_SELECTORS,
  stripBoilerplateMarkdown,
  stripBoilerplateDom,
} from '../../../src/extraction/boilerplate.js';

describe('boilerplate constants', () => {
  it('BOILERPLATE_TEXT_EQUALITY includes expected case-insensitive trimmed entries', () => {
    const expected = [
      'was this helpful?',
      'send',
      'edit this page',
      'edit on github',
      'suggest changes',
      'skip to main content',
    ];
    for (const entry of expected) {
      expect(BOILERPLATE_TEXT_EQUALITY).toContain(entry);
    }
  });

  it('BOILERPLATE_TEXT_PATTERNS has a regex matching "Last updated on ..."', () => {
    const matched = BOILERPLATE_TEXT_PATTERNS.some((re) =>
      re.test('Last updated on March 12, 2026'),
    );
    expect(matched).toBe(true);
  });

  it('BOILERPLATE_SELECTORS includes expected entries', () => {
    const expected = [
      '[class*="feedback"]',
      '[class*="edit-page"]',
      '[aria-label*="Edit"]',
      'footer[class*="docs"]',
      '[class*="sticky-cta"]',
      'main [role="banner"]',
      '[role="navigation"]',
      '[class*="sidebar"]',
      '[data-collection="docs"]',
    ];
    for (const sel of expected) {
      expect(BOILERPLATE_SELECTORS).toContain(sel);
    }
  });
});

describe('stripBoilerplateMarkdown', () => {
  it('strips an exact-match boilerplate line', () => {
    const out = stripBoilerplateMarkdown('Some content\nWas this helpful?\nMore content');
    expect(out).toBe('Some content\nMore content');
  });

  it('strips "Last updated on ..." pattern lines', () => {
    const out = stripBoilerplateMarkdown('Foo\nLast updated on March 12, 2026\nBar');
    expect(out).toBe('Foo\nBar');
  });

  it('returns input unchanged when nothing matches', () => {
    const input = 'Hello world\nThis is fine';
    expect(stripBoilerplateMarkdown(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(stripBoilerplateMarkdown('')).toBe('');
  });
});

describe('stripBoilerplateDom', () => {
  it('removes elements matching selectors and leaves others', () => {
    const html = `
      <html><body>
        <div class="feedback-widget">feedback</div>
        <p>real content</p>
        <a class="edit-page-link">edit</a>
        <span aria-label="Edit on GitHub">edit aria</span>
        <footer class="docs-footer">footer</footer>
        <div class="sticky-cta">cta</div>
        <main><div role="banner">banner</div><p>main text</p></main>
      </body></html>
    `;
    const { document } = parseHTML(html);
    stripBoilerplateDom(document);
    const out = document.body.innerHTML;
    expect(out).not.toContain('feedback-widget');
    expect(out).not.toContain('edit-page-link');
    expect(out).not.toContain('aria-label="Edit on GitHub"');
    expect(out).not.toContain('docs-footer');
    expect(out).not.toContain('sticky-cta');
    expect(out).not.toContain('role="banner"');
    expect(out).toContain('real content');
    expect(out).toContain('main text');
  });

  it('removes nav-equivalent elements (aside.sidebar, role=navigation, data-collection=docs)', () => {
    const html = `
      <html><body>
        <aside class="sidebar">side nav</aside>
        <nav role="navigation">primary nav</nav>
        <div data-collection="docs">docs collection</div>
        <p>kept content</p>
      </body></html>
    `;
    const { document } = parseHTML(html);
    stripBoilerplateDom(document);
    const out = document.body.innerHTML;
    expect(out).not.toContain('side nav');
    expect(out).not.toContain('primary nav');
    expect(out).not.toContain('docs collection');
    expect(out).toContain('kept content');
  });

  it('still removes real sidebars with compound class names (docs-sidebar, sidebar-nav)', () => {
    const html = `
      <html><body>
        <div class="docs-sidebar"><nav>compound side nav</nav></div>
        <div class="sidebar-nav">suffix side nav</div>
        <p>kept content</p>
      </body></html>
    `;
    const { document } = parseHTML(html);
    stripBoilerplateDom(document);
    const out = document.body.innerHTML;
    expect(out).not.toContain('compound side nav');
    expect(out).not.toContain('suffix side nav');
    expect(out).toContain('kept content');
  });

  it('does NOT remove a content-grid wrapper whose class merely contains the substring "sidebar"', () => {
    // react.dev wraps <main> + the reference-index <aside> in a grid container whose
    // Tailwind grid-template class is "grid-cols-sidebar-content". A substring match on
    // "sidebar" wrongly deletes that wrapper — and the entire article body with it.
    const html = `
      <html><body>
        <header><nav><a href="/">React</a></nav></header>
        <div class="grid grid-cols-only-content lg:grid-cols-sidebar-content 2xl:grid-cols-sidebar-content-toc">
          <main><h1>React Reference Overview</h1>
            <p>This section provides detailed reference documentation for working with React.</p>
          </main>
          <aside class="sidebar"><nav role="navigation"><a href="/reference/react">Hooks</a></nav></aside>
        </div>
      </body></html>
    `;
    const { document } = parseHTML(html);
    stripBoilerplateDom(document);
    const out = document.body.innerHTML;
    // The grid wrapper's <main> body must survive.
    expect(out).toContain('detailed reference documentation');
    expect(out).toContain('React Reference Overview');
    // The genuine sidebar/nav inside it is still removed.
    expect(out).not.toContain('role="navigation"');
  });

  it('does NOT remove a VitePress-style layout wrapper (has-sidebar) that contains <main>, but still removes a sibling sidebar', () => {
    // VitePress nests <main> inside <div class="VPContent has-sidebar"> /
    // <div class="VPContentDoc has-aside has-sidebar">. Both layout/state classes
    // contain the substring "sidebar" yet wrap the page body — the guard must keep
    // them. A genuine sibling sidebar that does not wrap <main> stays removable.
    const html = `
      <html><body>
        <header class="VPNav"><nav aria-label="Main Navigation">nav cluster</nav></header>
        <div class="VPContent has-sidebar">
          <aside class="docs-sidebar"><nav>Sidebar Navigation links</nav></aside>
          <div class="VPContentDoc has-aside has-sidebar">
            <main><h1>Introduction</h1>
              <p>Vue provides a declarative, component-based programming model.</p>
              <p>Single-File Components keep logic, template and styles together.</p>
            </main>
          </div>
        </div>
      </body></html>
    `;
    const { document } = parseHTML(html);
    stripBoilerplateDom(document);
    const out = document.body.innerHTML;
    // The main-containing wrappers and their body survive.
    expect(out).toContain('Single-File Components');
    expect(out).toContain('declarative, component-based');
    expect(out).toContain('<main>');
    // The genuine sibling sidebar (no <main>) is still stripped.
    expect(out).not.toContain('Sidebar Navigation links');
    expect(out).not.toContain('docs-sidebar');
  });

  it('still removes a sidebar that wraps <article> cards (guard is on <main>, not <article>)', () => {
    // Related-content / "more like this" rails are real sidebars that legitimately
    // wrap <article> cards. The guard keys on the single <main> landmark, so these
    // asides stay removable even though they contain <article>.
    const html = `
      <html><body>
        <main><p>Primary article body that should be kept intact for the reader.</p></main>
        <aside class="related-sidebar">
          <article class="card"><a href="/x">Related one</a></article>
          <article class="card"><a href="/y">Related two</a></article>
        </aside>
      </body></html>
    `;
    const { document } = parseHTML(html);
    stripBoilerplateDom(document);
    const out = document.body.innerHTML;
    expect(out).toContain('Primary article body');
    expect(out).not.toContain('related-sidebar');
    expect(out).not.toContain('Related one');
    expect(out).not.toContain('Related two');
  });
});
