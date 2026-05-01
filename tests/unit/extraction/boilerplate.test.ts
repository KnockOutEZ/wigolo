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
});
