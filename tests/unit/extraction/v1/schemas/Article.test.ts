import { describe, it, expect } from 'vitest';
import { extractArticle, cleanArticleBody } from '../../../../../src/extraction/v1/schemas/Article.js';

const BODY = `
  <p>This is a long-form article discussing distributed systems engineering,
  the trade-offs between consistency and availability, and the historical
  development of consensus algorithms.</p>
  <p>Vector clocks, Lamport timestamps, Paxos, Raft, and ZAB each address
  ordering and agreement in different ways. This piece walks through them.</p>
  <p>The reader is expected to have a working understanding of replication.</p>
`;

function buildHtml(metas = ''): string {
  return `<!doctype html><html><head><title>Distributed Systems Primer</title>${metas}</head><body><article>${BODY}</article></body></html>`;
}

describe('extractArticle', () => {
  const url = 'https://example.com/article';

  it('returns article fields when readability succeeds', async () => {
    const html = buildHtml(
      '<meta property="article:published_time" content="2024-05-01T10:00:00Z"><meta name="author" content="Alice">',
    );
    const result = await extractArticle(html, url);
    expect(result).not.toBeNull();
    expect(result!.title.length).toBeGreaterThan(0);
    expect(result!.body.length).toBeGreaterThan(0);
    expect(result!.url).toBe(url);
    expect(result!.date).toBe('2024-05-01T10:00:00Z');
  });

  it('returns null when news extractor returns null', async () => {
    const result = await extractArticle('<html><body><p>too short</p></body></html>', url);
    expect(result).toBeNull();
  });

  it('returns null on empty input', async () => {
    const result = await extractArticle('', url);
    expect(result).toBeNull();
  });
});

// named_schema=Article on Wikipedia-shaped pages dumped 30KB of refs +
// LaTeX + infobox/navbox chrome. cleanArticleBody is the targeted strip.
describe('cleanArticleBody — H11 chrome / refs / LaTeX strip', () => {
  it('strips a markdown References section and its list entries', () => {
    const body = [
      '# Article',
      '',
      'Real prose paragraph that must survive.',
      '',
      '## References',
      '',
      '1. Smith, J. "A paper." 2023.',
      '2. Doe, A. "Another paper." 2024.',
    ].join('\n');
    const cleaned = cleanArticleBody(body);
    expect(cleaned).toContain('Real prose paragraph');
    expect(cleaned.toLowerCase()).not.toContain('references');
    expect(cleaned).not.toContain('Smith, J.');
  });

  it('strips References, External links, See also, Further reading', () => {
    const body = [
      'Real prose.',
      '',
      '## References',
      '1. Foo.',
      '',
      '## See also',
      '- Other thing',
      '',
      '## External links',
      '- https://example.com',
      '',
      '## Further reading',
      '- Some book',
    ].join('\n');
    const cleaned = cleanArticleBody(body);
    expect(cleaned).toContain('Real prose');
    expect(cleaned).not.toContain('References');
    expect(cleaned).not.toContain('See also');
    expect(cleaned).not.toContain('External links');
    expect(cleaned).not.toContain('Further reading');
  });

  it('resumes copying after a non-chrome heading at the same level', () => {
    const body = [
      '# Article',
      '',
      'Intro paragraph.',
      '',
      '## References',
      '1. ref',
      '',
      '## Methodology',
      '',
      'Methodology prose that must survive.',
    ].join('\n');
    const cleaned = cleanArticleBody(body);
    expect(cleaned).toContain('Intro paragraph');
    expect(cleaned).toContain('Methodology prose that must survive');
    expect(cleaned).not.toContain('ref');
  });

  it('strips display LaTeX blocks `$$ … $$`', () => {
    const body = [
      'Some prose.',
      '',
      '$$ L = -\\sum p_i \\log q_i $$',
      '',
      'More prose afterwards.',
    ].join('\n');
    const cleaned = cleanArticleBody(body);
    expect(cleaned).toContain('Some prose');
    expect(cleaned).toContain('More prose afterwards');
    expect(cleaned).not.toContain('$$');
    expect(cleaned).not.toContain('\\sum');
  });

  it('preserves inline dollar amounts (does not over-strip `$ … $`)', () => {
    // Inline $...$ is finance / pricing markup on news articles. Only
    // display math `$$ … $$` should be removed.
    const body = 'The revenue was $5.2M in Q1 and $7.1M in Q2.';
    const cleaned = cleanArticleBody(body);
    expect(cleaned).toBe(body);
  });

  it('drops residual navbox markdown table rows', () => {
    const body = [
      'Real prose.',
      '',
      '| Cite this page | Wikidata item |',
      '| --- | --- |',
      '| link | link |',
      '',
      'More prose.',
    ].join('\n');
    const cleaned = cleanArticleBody(body);
    expect(cleaned).toContain('Real prose');
    expect(cleaned).toContain('More prose');
    expect(cleaned).not.toContain('Cite this page');
    expect(cleaned).not.toContain('Wikidata item');
  });

  it('strips inline [edit] links emitted by Wikipedia exports', () => {
    const body = '## History [edit]\n\nReal prose.';
    const cleaned = cleanArticleBody(body);
    expect(cleaned).not.toContain('[edit]');
    expect(cleaned).toContain('Real prose');
  });

  it('is a no-op on empty / undefined input', () => {
    expect(cleanArticleBody('')).toBe('');
  });
});
