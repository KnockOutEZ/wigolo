import { describe, it, expect } from 'vitest';
import { buildEvidenceItem, stableCitationId } from '../../../src/search/evidence.js';

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
