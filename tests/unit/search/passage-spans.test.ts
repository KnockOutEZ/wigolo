import { describe, it, expect } from 'vitest';
import { splitIntoPassages, mapPassageHeadings } from '../../../src/search/highlights.js';

const MD = `# Intro

First paragraph that is long enough to survive the min length filter and exercise span tracking properly.

## Details

Second paragraph that is also long enough for the min length filter and contains enough words to pass.

### Sub

Third paragraph deep inside a sub-section that we care about and is also long enough to pass the filter.
`;

describe('splitIntoPassages spans', () => {
  it('returns text + char offsets matching the source', () => {
    const passages = splitIntoPassages(MD);
    expect(passages.length).toBeGreaterThan(0);
    for (const p of passages) {
      expect(MD.slice(p.charStart, p.charEnd)).toContain(p.text.slice(0, 40));
      expect(p.charEnd).toBeGreaterThan(p.charStart);
    }
  });

  it('skips heading-only blocks', () => {
    const passages = splitIntoPassages(MD);
    expect(passages.find(p => p.text.startsWith('#'))).toBeUndefined();
  });

  it('charEnd matches text length when paragraph exceeds MAX_PASSAGE_LENGTH', () => {
    const longPara = 'word '.repeat(200); // 1000 chars, well over the 500 cap
    const md = '# Heading\n\n' + longPara;
    const passages = splitIntoPassages(md);
    const p = passages[0];
    expect(p.text.length).toBeLessThanOrEqual(500);
    expect(p.charEnd - p.charStart).toBe(p.text.length);
    expect(md.slice(p.charStart, p.charEnd)).toBe(p.text);
  });

  // P4c — the 500-char cap was a bare `.slice()` and stopped mid-word. It is
  // now boundary-aware, but deliberately marker-free: a passage carries a
  // source_span, and appending an ellipsis would make `text` stop being a
  // verbatim quote of the region the span points at. Both properties are
  // asserted together because a fix for either one alone breaks the other.
  it('cuts an over-long paragraph on a word boundary and stays a verbatim quote', () => {
    const longPara = 'reconciliation '.repeat(60); // 900 chars, over the cap
    const md = '# Heading\n\n' + longPara.trim();
    const p = splitIntoPassages(md)[0];

    expect(p.text.length).toBeLessThanOrEqual(500);
    expect(md.slice(p.charStart, p.charEnd)).toBe(p.text);
    expect(p.text).not.toMatch(/…/);
    // Ends on a complete word: the next source character is whitespace or EOF.
    const next = md.slice(p.charEnd, p.charEnd + 1);
    expect(next === '' || /\s/.test(next)).toBe(true);
  });
});

describe('mapPassageHeadings', () => {
  it('assigns nearest preceding heading to each passage', () => {
    const passages = splitIntoPassages(MD);
    const annotated = mapPassageHeadings(MD, passages);
    expect(annotated[0].sectionHeading).toBe('Intro');
    expect(annotated[1].sectionHeading).toBe('Details');
    expect(annotated[2].sectionHeading).toBe('Sub');
  });

  it('returns null when no preceding heading', () => {
    const md = 'No heading here. Just a paragraph long enough to pass the min length filter for split into passages.';
    const passages = splitIntoPassages(md);
    const annotated = mapPassageHeadings(md, passages);
    expect(annotated[0].sectionHeading).toBeNull();
  });
});
