import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentAppearsEmpty, looksLikeShell } from '../../../src/fetch/content-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../fixtures/spa-shells', name), 'utf-8');

describe('contentAppearsEmpty', () => {
  it('detects React SPA shell', () => {
    expect(contentAppearsEmpty(fixture('react-spa.html'))).toBe(true);
  });

  it('detects empty Next.js page', () => {
    expect(contentAppearsEmpty(fixture('next-empty.html'))).toBe(true);
  });

  it('detects Vue SPA shell', () => {
    expect(contentAppearsEmpty(fixture('vue-spa.html'))).toBe(true);
  });

  it('detects noscript-required pages', () => {
    expect(contentAppearsEmpty(fixture('noscript-required.html'))).toBe(true);
  });

  it('detects script-heavy pages', () => {
    expect(contentAppearsEmpty(fixture('script-heavy.html'))).toBe(true);
  });

  it('passes normal pages', () => {
    expect(contentAppearsEmpty(fixture('normal-page.html'))).toBe(false);
  });

  it('detects thin content pages', () => {
    expect(contentAppearsEmpty(fixture('thin-content.html'))).toBe(true);
  });

  it('detects shell-id pages with nav content but no <main>/<article>', () => {
    // Simulates react.dev: substantial nav text in <div id="root"> but the
    // article body only mounts via client-side hydration, so the page has
    // neither <main> nor <article>.
    const html = `<!doctype html><html><body><div id="root">
      <header><a href="/">Home</a><a href="/learn">Learn</a><a href="/reference">Reference</a></header>
      <nav>${'<a href="/x">Link</a>'.repeat(40)}</nav>
    </div></body></html>`;
    expect(contentAppearsEmpty(html)).toBe(true);
  });

  it('keeps shell-id pages that DO have <main>/<article>', () => {
    const html = `<!doctype html><html><body><div id="root">
      <header><a href="/">Home</a></header>
      <main>${'<p>Real article body content here that meaningfully describes the topic.</p>'.repeat(10)}</main>
    </div></body></html>`;
    expect(contentAppearsEmpty(html)).toBe(false);
  });
});

/**
 * WHY: looksLikeShell feeds the machine-facing `js_required` flag, so it must
 * never claim a page needs JavaScript unless the body carries a structural
 * shell marker. contentAppearsEmpty is deliberately looser: it is a routing
 * predicate where a wrong escalate only costs a retry.
 */
describe('looksLikeShell', () => {
  it('detects the same structural shells as contentAppearsEmpty', () => {
    expect(looksLikeShell(fixture('react-spa.html'))).toBe(true);
    expect(looksLikeShell(fixture('next-empty.html'))).toBe(true);
    expect(looksLikeShell(fixture('vue-spa.html'))).toBe(true);
    expect(looksLikeShell(fixture('noscript-required.html'))).toBe(true);
    expect(looksLikeShell(fixture('script-heavy.html'))).toBe(true);
  });

  it('rejects a short body that contentAppearsEmpty routes on length alone', () => {
    // Both predicates see the same HTML. Routing must escalate (a short body
    // may be a shell). The flag must not, because this page is complete.
    const html = '<html><body><h1>Service status</h1><p>All systems operational.</p></body></html>';
    expect(contentAppearsEmpty(html)).toBe(true);
    expect(looksLikeShell(html)).toBe(false);
  });

  it('rejects a normal substantive page', () => {
    expect(looksLikeShell(fixture('normal-page.html'))).toBe(false);
  });

  it('rejects a complete article that contains an empty widget mount', () => {
    // A mount point can sit in a fully server-rendered page: a comments widget,
    // a search box. The article is readable without JavaScript, so the empty
    // div alone must not set the flag.
    const html = `<html><body><main><h1>Release notes</h1><p>${'The release fixes three defects and adds two tests. '.repeat(20)}</p><div id="comments-widget"></div></main></body></html>`;
    expect(looksLikeShell(html)).toBe(false);
  });

  it('flags an empty mount under an arbitrary id when the body is thin', () => {
    // The mirror case: a custom bundle mounts into its own id. With almost no
    // readable body, that is still a shell.
    const html = '<html><body><div id="sfx-widget"></div></body></html>';
    expect(looksLikeShell(html)).toBe(true);
  });

  it('rejects a served article whose inline script dominates the markup', () => {
    // A high script ratio is only a shell signal when the body is thin. A docs
    // page can ship a large inline bundle and still be complete.
    const html = `<html><body><main><p>${'Complete server-rendered documentation text. '.repeat(20)}</p></main><script>${'var x=1;'.repeat(400)}</script></body></html>`;
    expect(looksLikeShell(html)).toBe(false);
  });

  it('rejects a noscript notice that is not about JavaScript', () => {
    // "Enable images" is not a JavaScript warning. The page is complete.
    const html = '<html><body><p>Gallery</p><noscript>Enable images for the optional preview</noscript></body></html>';
    expect(looksLikeShell(html)).toBe(false);
  });

  it('still flags a genuine noscript JavaScript warning', () => {
    const html = '<html><body><noscript>You need to enable JavaScript to use this app.</noscript></body></html>';
    expect(looksLikeShell(html)).toBe(true);
  });
});
