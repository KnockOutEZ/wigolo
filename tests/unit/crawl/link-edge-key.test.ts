import { describe, it, expect } from 'vitest';
import { linkEdgeKey } from '../../../src/crawl/crawler.js';

describe('linkEdgeKey — separator is the NUL escape, not a raw byte', () => {
  // WHY: the link-graph dedup Set keys edges by (from, fragment-stripped to).
  // The separator MUST be U+0000 — a byte that cannot occur in a URL — so two
  // distinct (from, to) pairs can never collide by straddling the boundary
  // (e.g. from='a', to='b/c' vs from='a/b', to='c' would both flatten to the
  // same string under a join with no unambiguous delimiter). It is written as
  // the NUL escape, never a raw NUL byte, so the source stays grep-visible
  // (see scripts/check-no-nul.mjs). This pin REDs if the separator degrades to
  // a space (char 32) or vanishes — charCodeAt, not toContain, catches both.
  it('places U+0000 exactly at the from/to boundary', () => {
    const from = 'https://a.test/x';
    const key = linkEdgeKey(from, 'https://a.test/y');
    expect(key.charCodeAt(from.length)).toBe(0);
  });
});
