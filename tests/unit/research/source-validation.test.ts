import { describe, it, expect } from 'vitest';
import {
  classifyUrlShape,
  queryContentTerms,
  gateContent,
} from '../../../src/research/source-validation.js';

describe('classifyUrlShape', () => {
  it('rejects a bare-root homepage as homepage', () => {
    // WHY: a homepage URL gives nav/marketing, never article text — it is
    // never a usable research source and must not occupy a source slot.
    expect(classifyUrlShape('https://www.google.com/')).toEqual({
      reject: true,
      reason: 'homepage',
    });
    expect(classifyUrlShape('https://example.com')).toEqual({
      reject: true,
      reason: 'homepage',
    });
  });

  it('rejects a search-engine results page as serp', () => {
    // WHY: a SERP is a list of links, not content — the C1 benchmark leaked a
    // Google results page and a blog-search results page into the brief.
    expect(classifyUrlShape('https://www.google.com/search?q=fts5+vs+vector+db')).toEqual({
      reject: true,
      reason: 'serp',
    });
    expect(classifyUrlShape('https://www.bing.com/search?q=anything')).toEqual({
      reject: true,
      reason: 'serp',
    });
  });

  it('rejects a startpage.com results page as serp (Wave-2 W3 decision lock)', () => {
    // WHY: the 'startpage' label in SEARCH_ENGINE_LABELS is a live SERP-junk
    // filter — startpage.com is a real, operating search engine whose results
    // pages can enter a research source pool. Wave-2 W3 considered dropping
    // this label (mistaken for a dead never-built engine adapter) and kept it:
    // dropping it would re-leak startpage SERPs into briefs. This test locks
    // that decision so the label is not removed by a future reader.
    expect(classifyUrlShape('https://www.startpage.com/search?q=fts5+vs+vector+db')).toEqual({
      reject: true,
      reason: 'serp',
    });
  });

  it('rejects a blog-search results path as serp on any host', () => {
    // WHY: the leaked Japanese junk source was a blog-search results page; its
    // host is not a mainstream engine, so the path signature must catch it.
    expect(classifyUrlShape('https://blogsearch.example.jp/blogsearch?q=foo').reject).toBe(true);
    expect(classifyUrlShape('https://blogsearch.example.jp/blogsearch?q=foo').reason).toBe('serp');
  });

  it('keeps a normal content URL with a real path', () => {
    expect(classifyUrlShape('https://react.dev/reference/react')).toEqual({ reject: false });
    expect(classifyUrlShape('https://alexgarcia.xyz/sqlite-vec/api-reference.html')).toEqual({
      reject: false,
    });
  });

  it('keeps a bare-root URL when its host is an explicit include_domains target', () => {
    // WHY: if the caller deliberately scoped research to a domain, its root is
    // an intentional target, not junk — dropping it would defeat the request.
    expect(
      classifyUrlShape('https://docs.stripe.com/', ['docs.stripe.com']),
    ).toEqual({ reject: false });
  });

  it('does not treat a search-engine host as a SERP when the path is real content', () => {
    // WHY: not every URL on a search-engine domain is a results page (e.g. a
    // blog post); only the /search results path is a SERP.
    expect(classifyUrlShape('https://blog.google/products/search/some-article/')).toEqual({
      reject: false,
    });
  });

  it('does not misclassify hosts that merely contain an engine token as a substring', () => {
    // WHY: substring host-matching ("ask." inside "task.", "flask.") would
    // silently drop legitimate research sources. Engine detection must match on
    // domain-label boundaries, not substrings.
    expect(classifyUrlShape('https://task.evil.com/search?q=x')).toEqual({ reject: false });
    expect(classifyUrlShape('https://flask.palletsprojects.com/search?q=x')).toEqual({
      reject: false,
    });
    expect(classifyUrlShape('https://notgoogle.com/search?q=x')).toEqual({ reject: false });
  });

  it('rejects a malformed URL rather than throwing', () => {
    // WHY: classifyUrlShape must never throw on bad input — an unparseable URL
    // is not a usable source.
    expect(classifyUrlShape('not a url').reject).toBe(true);
  });
});

describe('queryContentTerms', () => {
  it('strips stop-words and keeps distinct content terms lowercased', () => {
    const terms = queryContentTerms(
      'tradeoffs between SQLite FTS5 and a dedicated vector database for local semantic search',
    );
    expect(terms).toContain('sqlite');
    expect(terms).toContain('fts5');
    expect(terms).toContain('vector');
    expect(terms).not.toContain('and');
    expect(terms).not.toContain('a');
    expect(terms).not.toContain('for');
    // distinct
    expect(new Set(terms).size).toBe(terms.length);
  });
});

describe('gateContent', () => {
  const terms = queryContentTerms('SQLite FTS5 vector database tradeoffs');

  it('rejects a near-empty off-topic shell as low-content', () => {
    // WHY: an empty app-shell or error stub has near-zero words and none of the
    // query terms — it contributes nothing to synthesis.
    const v = gateContent('Loading...', terms);
    expect(v).toEqual({ reject: true, reason: 'low-content' });
  });

  it('rejects a short off-topic snippet as low-overlap', () => {
    // WHY: a short blurb about an unrelated topic is junk even if it is not
    // literally empty.
    const offTopic = 'Buy cheap flights and hotels today with our travel deals booking site.';
    const v = gateContent(offTopic, terms);
    expect(v).toEqual({ reject: true, reason: 'low-overlap' });
  });

  it('keeps a short but on-topic page', () => {
    // WHY: brevity is not junk — a concise on-topic doc must survive the gate;
    // the gate punishes empty-shells, not short relevant content.
    const shortOnTopic = 'SQLite FTS5 vs a vector database: tradeoffs for search.';
    expect(gateContent(shortOnTopic, terms)).toEqual({ reject: false });
  });

  it('keeps a long page even when it is off-topic', () => {
    // WHY: the gate is not a relevance filter — rerank already owns relevance.
    // A substantial page is real content and must not be dropped here.
    const longOffTopic = Array.from({ length: 120 }, () => 'lorem ipsum dolor sit amet').join(' ');
    expect(gateContent(longOffTopic, terms)).toEqual({ reject: false });
  });

  it('pins the low-content / low-overlap reason boundary at the word threshold', () => {
    // WHY: the reason reported depends on NEAR_EMPTY_WORDS (10) — a 10-word
    // off-topic page is a shell (low-content), an 11-word one is short prose
    // that simply missed the query (low-overlap). Lock the boundary so a
    // mutation of the constant is caught.
    const tenWords = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    const elevenWords = `${tenWords} kilo`;
    expect(gateContent(tenWords, terms)).toEqual({ reject: true, reason: 'low-content' });
    expect(gateContent(elevenWords, terms)).toEqual({ reject: true, reason: 'low-overlap' });
  });

  it('keeps everything when there are no query terms', () => {
    // WHY: with nothing to measure overlap against, dropping on overlap would
    // nuke all sources — fail open.
    expect(gateContent('x', [])).toEqual({ reject: false });
  });
});
