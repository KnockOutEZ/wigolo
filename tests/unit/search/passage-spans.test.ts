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
