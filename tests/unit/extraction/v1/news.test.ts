import { describe, it, expect } from 'vitest';
import { extractNews } from '../../../../src/extraction/v1/news.js';

const ARTICLE_BODY = `
  <p>This is an in-depth article about distributed systems and the challenges
  they pose. We will cover replication, consistency, and consensus algorithms
  in some detail across multiple paragraphs.</p>
  <p>The history of distributed systems goes back decades. Many early systems
  used clock synchronization to coordinate. Modern systems often use vector
  clocks or logical timestamps to maintain ordering.</p>
  <p>Common consensus algorithms include Paxos, Raft, and ZAB. Each has
  trade-offs around understandability and performance.</p>
`;

function buildArticleHtml(opts: {
  metas?: string;
  timeTag?: string;
  jsonLd?: string;
  body?: string;
}): string {
  const head = [
    '<title>Distributed Systems Primer</title>',
    opts.metas ?? '',
    opts.jsonLd ?? '',
  ].join('\n');
  const body = opts.body ?? `<article>${opts.timeTag ?? ''}${ARTICLE_BODY}</article>`;
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

describe('extractNews — readability path', () => {
  const url = 'https://example.com/news/distributed';

  it('returns null when readability cannot produce content', async () => {
    const html = '<html><head></head><body><p>too short</p></body></html>';
    expect(await extractNews(html, url)).toBeNull();
  });

  it('returns a result with markdown when readability succeeds', async () => {
    const html = buildArticleHtml({});
    const result = await extractNews(html, url);
    expect(result).not.toBeNull();
    expect(result!.markdown.length).toBeGreaterThan(100);
    expect(['readability', 'site-specific']).toContain(result!.extractor);
  });
});

describe('extractNews — date heuristics', () => {
  const url = 'https://example.com/news/article';

  it('does not overwrite an existing metadata.date', async () => {
    // readability sets date from article metadata when present; emulate by
    // shipping a published_time meta — but assert we keep first non-empty.
    const html = buildArticleHtml({
      metas: '<meta property="article:published_time" content="2024-05-01T10:00:00Z">',
    });
    const result = await extractNews(html, url);
    expect(result).not.toBeNull();
    expect(result!.metadata.date).toBe('2024-05-01T10:00:00Z');
  });

  it('falls back to <time datetime> inside <article>', async () => {
    const html = buildArticleHtml({
      timeTag: '<time datetime="2023-11-12T08:30:00Z">Nov 12</time>',
    });
    const result = await extractNews(html, url);
    expect(result).not.toBeNull();
    expect(result!.metadata.date).toBe('2023-11-12T08:30:00Z');
  });

  it('falls back to itemprop=datePublished meta', async () => {
    const html = buildArticleHtml({
      metas: '<meta itemprop="datePublished" content="2022-06-15">',
    });
    const result = await extractNews(html, url);
    expect(result).not.toBeNull();
    expect(result!.metadata.date).toBe('2022-06-15');
  });

  it('falls back to JSON-LD datePublished', async () => {
    const jsonLd = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: 'Foo',
      datePublished: '2021-03-04T12:00:00Z',
    })}</script>`;
    const html = buildArticleHtml({ jsonLd });
    const result = await extractNews(html, url);
    expect(result).not.toBeNull();
    expect(result!.metadata.date).toBe('2021-03-04T12:00:00Z');
  });

  it('leaves date undefined when no signal exists', async () => {
    const html = buildArticleHtml({});
    const result = await extractNews(html, url);
    expect(result).not.toBeNull();
    expect(result!.metadata.date).toBeUndefined();
  });

  it('ignores invalid date strings', async () => {
    const html = buildArticleHtml({
      metas: '<meta name="date" content="not a date at all">',
    });
    const result = await extractNews(html, url);
    expect(result).not.toBeNull();
    expect(result!.metadata.date).toBeUndefined();
  });
});

describe('extractNews — robustness', () => {
  it('does not throw on malformed JSON-LD', async () => {
    const html = `<html><head>
      <script type="application/ld+json">{not valid json</script>
    </head><body><article>${ARTICLE_BODY}</article></body></html>`;
    const result = await extractNews(html, 'https://example.com/x');
    expect(result).not.toBeNull();
  });
});
