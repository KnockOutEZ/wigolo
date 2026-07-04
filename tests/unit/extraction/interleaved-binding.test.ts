import { describe, it, expect } from 'vitest';
import { extractTables } from '../../../src/extraction/extract.js';

// Field-binding correctness for the interleaved multi-tr listing segmenter.
//
// The prior segmenter picked "longest cell = title", which swapped title<->meta
// on any record whose meta line ("342 points by alice … | 128 comments") ran
// longer than the title, and it read only cell TEXT so the story's anchor href
// was lost and points/comments stayed embedded in prose rather than typed.

// One story laid out as a rank/title row + a subtext meta row + a spacer — the
// canonical interleaved-listing cycle. Deliberately NON-HN class names so the
// binding keys on STRUCTURE (leading anchor = title), not any site string.
const story = (
  rank: number,
  id: number,
  title: string,
  points: number,
  comments: number,
): string => `
  <tr class="entry">
    <td class="idx"><span class="rank">${rank}.</span></td>
    <td class="vote"><a href="/vote?id=${id}"><span class="arrow"></span></a></td>
    <td class="subject"><a href="/story/${id}">${title}</a></td>
  </tr>
  <tr class="meta-row">
    <td colspan="2"></td>
    <td class="meta"><span class="score">${points} points</span> by <a href="/u/author">author</a> <a href="/item/${id}">${comments} comments</a></td>
  </tr>
  <tr class="spacer"></tr>`;

const html = `<html><body>
  <table class="listing">
    ${story(1, 101, 'Building a columnar query engine from scratch', 342, 128)}
    ${story(2, 102, 'Why', 211, 87)}
    ${story(3, 103, 'Distributed consensus without a coordinator service in practice', 189, 64)}
  </table>
</body></html>`;

function listingRows() {
  const tables = extractTables(html);
  const listing = tables.find((t) =>
    t.rows.some((r) => Object.values(r).some((v) => v.includes('columnar query engine'))),
  );
  expect(listing).toBeDefined();
  return listing!.rows;
}

describe('interleaved-listing field binding', () => {
  it('binds the story anchor text as the title — even when meta is longer', () => {
    const rows = listingRows();
    expect(rows).toHaveLength(3);
    // Row 1: a long title, longer-than-title meta. The old longest-cell rule
    // put the meta line in `title`; deterministic anchor-binding must not.
    expect(rows[0].title).toBe('Building a columnar query engine from scratch');
    // Row 2: a SHORT one-word title ("Why") is much shorter than its meta. The
    // longest-cell rule would definitely have mis-bound this one.
    expect(rows[1].title).toBe('Why');
    expect(rows[2].title).toBe(
      'Distributed consensus without a coordinator service in practice',
    );
  });

  it('does not swap title into the meta column', () => {
    const rows = listingRows();
    for (const r of rows) {
      expect(r.meta ?? '').not.toContain(r.title);
    }
  });

  it('captures the story anchor href per row', () => {
    const rows = listingRows();
    expect(rows[0].href).toBe('/story/101');
    expect(rows[1].href).toBe('/story/102');
    expect(rows[2].href).toBe('/story/103');
  });

  it('types numeric metrics (points, comments) as parseable fields', () => {
    const rows = listingRows();
    // The record's numeric metrics surface as typed numeric-string fields so an
    // agent/schema reads them as numbers, not buried in a prose meta blob.
    const numericValues0 = Object.values(rows[0]).filter((v) => /^\d+$/.test(v));
    expect(numericValues0).toContain('342');
    expect(numericValues0).toContain('128');
  });
});

describe('interleaved-listing byline-first layout', () => {
  // The author/profile link precedes the story link in each record. A
  // "first non-metric anchor" rule bound title to the author handle
  // ("jane" / "/u/jane"); the title must be the story link, not the byline.
  const story = (rank: number, id: number, author: string, title: string): string => `
    <tr class="entry">
      <td class="idx"><span class="rank">${rank}.</span></td>
      <td class="byline"><a href="/u/${author}">${author}</a></td>
      <td class="subject"><a href="/story/${id}">${title}</a></td>
    </tr>
    <tr class="meta"><td colspan="2"></td>
      <td><span class="score">${100 + id} points</span> <a href="/item/${id}">${id} comments</a></td></tr>
    <tr class="spacer"></tr>`;

  const html = `<html><body><table class="listing">
    ${story(1, 101, 'jane', 'Building a columnar query engine from scratch')}
    ${story(2, 102, 'bob', 'Understanding lock-free ring buffers in audio')}
    ${story(3, 103, 'amy', 'A practical tour of tracing garbage collectors')}
  </table></body></html>`;

  function rows() {
    const listing = extractTables(html).find((t) =>
      t.rows.some((r) => Object.values(r).some((v) => v.includes('columnar query engine'))),
    );
    expect(listing).toBeDefined();
    return listing!.rows;
  }

  it('binds title to the story link, not the leading author byline', () => {
    const r = rows();
    expect(r[0].title).toBe('Building a columnar query engine from scratch');
    expect(r[0].href).toBe('/story/101');
    expect(r[1].title).toBe('Understanding lock-free ring buffers in audio');
    expect(r[1].href).toBe('/story/102');
    // The author handle must not become the title.
    for (const row of r) {
      expect(row.title).not.toBe('jane');
      expect(row.title).not.toBe('bob');
      expect(row.title).not.toBe('amy');
    }
  });
});
