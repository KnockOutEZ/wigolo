import { describe, it, expect } from 'vitest';
import {
  applyAggregateMarkdownBudget,
  buildEvidenceFromMarkdown,
  buildEvidenceItem,
  stableCitationId,
} from '../../../src/search/evidence.js';

describe('stableCitationId', () => {
  it('is identical for the same url + start across calls', () => {
    expect(stableCitationId('https://x.com/a', 100)).toBe(stableCitationId('https://x.com/a', 100));
  });
  it('differs by url', () => {
    expect(stableCitationId('https://x.com/a', 100)).not.toBe(stableCitationId('https://x.com/b', 100));
  });
  it('differs by start offset', () => {
    expect(stableCitationId('https://x.com/a', 100)).not.toBe(stableCitationId('https://x.com/a', 200));
  });
  it('returns a 12-char lowercase hex string', () => {
    expect(stableCitationId('https://x.com/a', 0)).toMatch(/^[a-f0-9]{12}$/);
  });
});

describe('buildEvidenceItem', () => {
  it('packs title/url/section/excerpt/score/citation_id/source_span', () => {
    const ev = buildEvidenceItem({
      title: 'T',
      url: 'https://x.com/a',
      sectionHeading: 'Intro',
      excerpt: 'hello world',
      score: 0.8,
      sourceSpan: { start: 100, end: 130 },
    });
    expect(ev.title).toBe('T');
    expect(ev.url).toBe('https://x.com/a');
    expect(ev.section_heading).toBe('Intro');
    expect(ev.excerpt).toBe('hello world');
    expect(ev.score).toBe(0.8);
    expect(ev.source_span).toEqual({ start: 100, end: 130 });
    expect(ev.citation_id).toBe(stableCitationId('https://x.com/a', 100));
  });
  it('passes null section_heading when none', () => {
    const ev = buildEvidenceItem({
      title: 'T', url: 'https://x.com/a', sectionHeading: null,
      excerpt: 'x', score: 0, sourceSpan: { start: 0, end: 1 },
    });
    expect(ev.section_heading).toBeNull();
  });
});

describe('applyAggregateMarkdownBudget', () => {
  interface Item { body: string }
  const longBody = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa. '.repeat(60);

  function run(items: Item[], opts: { maxTokensOut?: number; maxChars?: number; minTokensPerItem?: number }) {
    applyAggregateMarkdownBudget(
      items,
      (i) => i.body,
      (i, body) => { i.body = body; },
      opts,
    );
    return items;
  }

  it('without minTokensPerItem: exhausted budget clears later bodies (unchanged behavior)', () => {
    const items: Item[] = [{ body: longBody }, { body: longBody }, { body: longBody }];
    run(items, { maxTokensOut: 40 });
    // First item consumes the budget; later bodied items are cleared to ''.
    expect(items[0].body.length).toBeGreaterThan(0);
    expect(items[items.length - 1].body).toBe('');
  });

  it('minTokensPerItem: every item that HAD a body keeps >=1 char even past the budget', () => {
    // WHY: crawl must never empty a later page's real content while an earlier
    // page kept content. The per-item floor beats shared-budget starvation.
    const items: Item[] = [{ body: longBody }, { body: longBody }, { body: longBody }, { body: longBody }];
    run(items, { maxTokensOut: 20, minTokensPerItem: 32 });
    for (const it of items) {
      expect(it.body.length).toBeGreaterThan(0);
    }
  });

  it('minTokensPerItem: an item WITHOUT a body stays empty (never fabricates content)', () => {
    const items: Item[] = [{ body: longBody }, { body: '' }, { body: longBody }];
    run(items, { maxTokensOut: 10, minTokensPerItem: 32 });
    expect(items[0].body.length).toBeGreaterThan(0);
    expect(items[1].body).toBe(''); // empty source stays empty
    expect(items[2].body.length).toBeGreaterThan(0); // floored, not cleared
  });
});

describe('buildEvidenceFromMarkdown', () => {
  it('skips items whose truncated excerpt is only the truncation marker', async () => {
    const markdown =
      '# Heading\n\n' +
      'TypeScript is a strongly typed programming language built on JavaScript. ' +
      'It compiles to plain JavaScript and runs anywhere JavaScript runs at all.';
    const items = await buildEvidenceFromMarkdown(
      'TypeScript',
      'Title',
      'https://example.com/a',
      markdown,
      { maxTokensOut: 3 },
    );
    expect(items).toEqual([]);
  });
});
