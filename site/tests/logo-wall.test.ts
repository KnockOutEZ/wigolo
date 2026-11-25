import { describe, it, expect } from 'vitest';
import {
  buildWall,
  captionCount,
  resolveMark,
  type Company,
} from '../src/lib/logo-wall';

const icon = (over: Partial<Company> = {}): Company => ({
  name: 'Samsung',
  slug: 'samsung',
  tier: 1,
  evidence: 'self-reported',
  display: 'icon+name',
  logo: { source: 'simple-icons', id: 'samsung' },
  ...over,
});

describe('logo wall data', () => {
  it('resolves every curated company, so a bad entry fails the build rather than rendering a hole', () => {
    const wall = buildWall();
    expect(wall.top.length).toBeGreaterThan(0);
    expect(wall.bottom.length).toBeGreaterThan(0);
    for (const item of [...wall.top, ...wall.bottom]) {
      if (item.display === 'name') expect(item.mark.kind).toBe('none');
      else expect(item.mark.kind).not.toBe('none');
    }
  });

  it('puts tier 1 on the top row and tier 2 on the bottom', () => {
    const wall = buildWall([
      icon({ slug: 'a', tier: 1 }),
      icon({ slug: 'b', tier: 2 }),
      icon({ slug: 'c', tier: 1 }),
    ], {});
    expect(wall.top.map((i) => i.slug)).toEqual(['a', 'c']);
    expect(wall.bottom.map((i) => i.slug)).toEqual(['b']);
  });

  it('crops a wordmark to its glyph while framing it from the origin', () => {
    // <use> places a symbol at 0,0. A frame that starts at the crop offset
    // pushes the glyph out of view — the wordmark rendered as a blank gap.
    const mark = resolveMark(icon({ display: 'wordmark' }), {});
    if (mark.kind !== 'svg') throw new Error('expected svg');
    expect(mark.frame.startsWith('0 0 ')).toBe(true);
    expect(mark.viewBox).not.toBe('0 0 24 24');
    expect(mark.aspect).toBeGreaterThan(3);
  });

  it('refuses a raster logo with no recorded size, since it would render unsized', () => {
    expect(() =>
      resolveMark(icon({ logo: { source: 'github-avatar', org: 'x' } }), {}),
    ).toThrow(/raster size/);
  });

  it('refuses an unknown simple-icons id', () => {
    expect(() => resolveMark(icon({ logo: { source: 'simple-icons', id: 'nope-nope' } }), {})).toThrow();
  });
});

describe('star caption', () => {
  it('floors the latest count so the claim never overstates', () => {
    expect(captionCount([['2026-09-22', 5388], ['2026-09-23', 5399]], 1)).toBe(5300);
  });

  it('falls back on malformed data instead of printing 0 or NaN', () => {
    expect(captionCount(null, 5300)).toBe(5300);
    expect(captionCount([], 5300)).toBe(5300);
    expect(captionCount([['2026-09-23', 'x']], 5300)).toBe(5300);
  });
});
