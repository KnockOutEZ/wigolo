import { describe, it, expect } from 'vitest';
import {
  computeDiffEnvelope,
  computeUnifiedDiff,
  computeHunks,
  DIFF_LINE_CAP,
} from '../../../src/cache/diff-engine.js';

describe('computeUnifiedDiff', () => {
  // Why: a unified diff that doesn't match git semantics breaks downstream
  // consumers (humans reading patches, tools applying them).
  it('produces git-style header + @@ hunk for a single line change', () => {
    const oldText = 'one\ntwo\nthree\n';
    const newText = 'one\ntwo-changed\nthree\n';

    const result = computeUnifiedDiff(oldText, newText);

    expect(result.truncated).toBe(false);
    expect(result.diff).toContain('--- old');
    expect(result.diff).toContain('+++ new');
    expect(result.diff).toMatch(/^@@ /m);
    expect(result.diff).toContain('-two');
    expect(result.diff).toContain('+two-changed');
    // context lines (no prefix or single space) must be preserved for the
    // unchanged neighbors so reviewers see what surrounds the change
    expect(result.diff).toMatch(/^ one$/m);
    expect(result.diff).toMatch(/^ three$/m);
  });

  // Why: `unified=3` is the default for `git diff`. Mismatched context windows
  // make patches non-portable.
  it('uses 3 lines of context by default (matches git diff --unified=3)', () => {
    const oldLines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const newLines = [...oldLines];
    newLines[5] = 'CHANGED';

    const result = computeUnifiedDiff(oldLines.join('\n'), newLines.join('\n'));
    // lines 2-4 are pre-context, line 5 is the change, lines 6-8 are post-context
    expect(result.diff).toMatch(/^ line 2$/m);
    expect(result.diff).toMatch(/^ line 4$/m);
    expect(result.diff).toMatch(/^-line 5$/m);
    expect(result.diff).toMatch(/^\+CHANGED$/m);
    expect(result.diff).toMatch(/^ line 6$/m);
    expect(result.diff).toMatch(/^ line 8$/m);
    // beyond 3 lines of context should NOT be included
    expect(result.diff).not.toMatch(/^ line 1$/m);
    expect(result.diff).not.toMatch(/^ line 9$/m);
  });

  it('returns empty diff string when texts are identical', () => {
    const text = 'a\nb\nc\n';
    const result = computeUnifiedDiff(text, text);
    expect(result.summary.added_lines).toBe(0);
    expect(result.summary.removed_lines).toBe(0);
    expect(result.summary.modified_lines).toBe(0);
    expect(result.diff).toBe('');
  });

  // Why: inputs over the LCS size cap must not silently degrade; callers need
  // a clear signal so they can switch strategies (summary mode, sampling, etc.)
  it('sets truncated:true and returns approximate summary above the line cap', () => {
    const huge = Array.from({ length: DIFF_LINE_CAP + 10 }, (_, i) => `l${i}`).join('\n');
    const huge2 = Array.from({ length: DIFF_LINE_CAP + 20 }, (_, i) => `l${i}-v2`).join('\n');
    const result = computeUnifiedDiff(huge, huge2);
    expect(result.truncated).toBe(true);
    // when truncated we still emit a summary (line counts only)
    expect(result.summary.added_lines + result.summary.removed_lines).toBeGreaterThan(0);
  });
});

describe('computeHunks', () => {
  it('emits change_type:added when only additions occur', () => {
    const oldText = 'a\nb\n';
    const newText = 'a\nb\nc\nd\n';
    const result = computeHunks(oldText, newText, 'line');
    expect(result.hunks.some((h) => h.change_type === 'added')).toBe(true);
    expect(result.hunks.every((h) => h.change_type !== 'removed')).toBe(true);
  });

  it('emits change_type:removed when only removals occur', () => {
    const oldText = 'a\nb\nc\nd\n';
    const newText = 'a\nb\n';
    const result = computeHunks(oldText, newText, 'line');
    expect(result.hunks.some((h) => h.change_type === 'removed')).toBe(true);
    expect(result.hunks.every((h) => h.change_type !== 'added')).toBe(true);
  });

  it('emits change_type:modified when adjacent removes + adds pair up', () => {
    const oldText = 'header\nold body\nfooter\n';
    const newText = 'header\nnew body\nfooter\n';
    const result = computeHunks(oldText, newText, 'line');
    expect(result.hunks.some((h) => h.change_type === 'modified')).toBe(true);
  });

  describe('section granularity', () => {
    // Why: section walking is the unique feature for markdown — without it,
    // a single typo in the intro shows up next to an entire rewrite of §3.
    it('emits one hunk per modified H1/H2/H3 section, tagged with section_title', () => {
      const oldText = [
        '# Title',
        '',
        '## Intro',
        'first intro paragraph',
        '',
        '## Body',
        'body content',
        '',
        '### Detail',
        'detail content',
        '',
      ].join('\n');
      const newText = [
        '# Title',
        '',
        '## Intro',
        'rewritten intro paragraph',
        '',
        '## Body',
        'body content',
        '',
        '### Detail',
        'new detail content',
        '',
      ].join('\n');

      const result = computeHunks(oldText, newText, 'section');

      const titles = result.hunks.map((h) => h.section_title);
      expect(titles).toContain('Intro');
      expect(titles).toContain('Detail');
      // unchanged section ('Body') should NOT appear
      expect(titles).not.toContain('Body');
      // every section hunk must have before/after text so consumers can show
      // the side-by-side without an extra lookup
      for (const h of result.hunks) {
        expect(typeof h.before).toBe('string');
        expect(typeof h.after).toBe('string');
      }
    });

    it('treats prelude content before any heading as an unnamed section', () => {
      const oldText = 'intro line\n\n# H1\nbody\n';
      const newText = 'intro line changed\n\n# H1\nbody\n';
      const result = computeHunks(oldText, newText, 'section');
      // there must be at least one hunk corresponding to the prelude diff
      expect(result.hunks.length).toBeGreaterThan(0);
      const prelude = result.hunks.find((h) => !h.section_title);
      expect(prelude).toBeDefined();
      expect(prelude!.before).toContain('intro line');
      expect(prelude!.after).toContain('intro line changed');
    });
  });

  it('sets truncated:true above the line cap', () => {
    const huge = Array.from({ length: DIFF_LINE_CAP + 1 }, (_, i) => `l${i}`).join('\n');
    const huge2 = Array.from({ length: DIFF_LINE_CAP + 1 }, (_, i) => `l${i}-v2`).join('\n');
    const result = computeHunks(huge, huge2, 'line');
    expect(result.truncated).toBe(true);
    expect(result.hunks).toEqual([]);
  });
});

describe('computeDiffEnvelope', () => {
  it('returns changed:false and zero counts for identical inputs', () => {
    const text = '# Same\n\nSame body.\n';
    const out = computeDiffEnvelope({
      oldMarkdown: text,
      newMarkdown: text,
      output: 'unified',
      granularity: 'line',
    });
    expect(out.changed).toBe(false);
    expect(out.summary).toEqual({
      added_lines: 0,
      removed_lines: 0,
      modified_lines: 0,
      total_changed_chars: 0,
    });
    expect(out.unified_diff ?? '').toBe('');
  });

  it('returns unified_diff when output=unified and changes exist', () => {
    const out = computeDiffEnvelope({
      oldMarkdown: 'a\nb\nc\n',
      newMarkdown: 'a\nB\nc\n',
      output: 'unified',
      granularity: 'line',
    });
    expect(out.changed).toBe(true);
    expect(out.unified_diff).toBeDefined();
    expect(out.unified_diff).toContain('-b');
    expect(out.unified_diff).toContain('+B');
    expect(out.hunks).toBeUndefined();
  });

  it('returns hunks[] when output=hunks', () => {
    const out = computeDiffEnvelope({
      oldMarkdown: 'a\nb\nc\n',
      newMarkdown: 'a\nB\nc\n',
      output: 'hunks',
      granularity: 'line',
    });
    expect(out.changed).toBe(true);
    expect(Array.isArray(out.hunks)).toBe(true);
    expect(out.hunks!.length).toBeGreaterThan(0);
    expect(out.unified_diff).toBeUndefined();
  });

  it('returns only summary when output=summary (no hunks, no unified_diff)', () => {
    const out = computeDiffEnvelope({
      oldMarkdown: 'a\nb\nc\n',
      newMarkdown: 'a\nB\nc\nd\n',
      output: 'summary',
      granularity: 'line',
    });
    expect(out.changed).toBe(true);
    expect(out.hunks).toBeUndefined();
    expect(out.unified_diff).toBeUndefined();
    expect(out.summary!.added_lines + out.summary!.modified_lines).toBeGreaterThan(0);
  });

  // Why: section-granularity outputs are how callers diff long markdown docs;
  // without H1/H2/H3 walking the tool would be no better than `diff`.
  it('walks H1/H2/H3 boundaries when granularity=section + output=hunks', () => {
    const oldText = [
      '# Top',
      'top content',
      '## Section A',
      'old A',
      '### A.1',
      'old A.1',
      '## Section B',
      'B',
    ].join('\n');
    const newText = [
      '# Top',
      'top content',
      '## Section A',
      'new A',
      '### A.1',
      'new A.1',
      '## Section B',
      'B',
    ].join('\n');
    const out = computeDiffEnvelope({
      oldMarkdown: oldText,
      newMarkdown: newText,
      output: 'hunks',
      granularity: 'section',
    });
    expect(out.changed).toBe(true);
    const titles = out.hunks!.map((h) => h.section_title);
    // Section A and Section A.1 changed; Top and Section B unchanged.
    expect(titles).toContain('Section A');
    expect(titles).toContain('A.1');
  });

  it('flips truncated:true and includes summary when inputs exceed the line cap', () => {
    const huge = Array.from({ length: DIFF_LINE_CAP + 100 }, (_, i) => `line ${i}`).join('\n');
    const huge2 = Array.from({ length: DIFF_LINE_CAP + 100 }, (_, i) => `line ${i} changed`).join('\n');
    const out = computeDiffEnvelope({
      oldMarkdown: huge,
      newMarkdown: huge2,
      output: 'unified',
      granularity: 'line',
    });
    expect(out.truncated).toBe(true);
    expect(out.changed).toBe(true);
    // never silently degrade: summary is still populated so the caller knows
    // the magnitude of the change
    expect(out.summary).toBeDefined();
    expect(out.summary!.added_lines + out.summary!.removed_lines + out.summary!.modified_lines).toBeGreaterThan(0);
  });

  // Performance gate — round-trip must stay under 200ms on 1000 lines so the
  // tool stays interactive. If LCS regresses to quadratic blow-up this fails.
  it('completes a 1000-line diff in under 200ms', () => {
    const oldLines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    const newLines = [...oldLines];
    newLines[500] = 'changed mid-doc';
    newLines.push('appended');

    const start = Date.now();
    const out = computeDiffEnvelope({
      oldMarkdown: oldLines.join('\n'),
      newMarkdown: newLines.join('\n'),
      output: 'unified',
      granularity: 'line',
    });
    const elapsed = Date.now() - start;
    expect(out.changed).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });

  it('counts total_changed_chars across all add+remove lines', () => {
    const out = computeDiffEnvelope({
      oldMarkdown: 'aaa\nbb\n',
      newMarkdown: 'AAA\nbb\nCC\n',
      output: 'summary',
      granularity: 'line',
    });
    // changed chars: removed 'aaa' (3) + added 'AAA' (3) + added 'CC' (2) = 8
    expect(out.summary!.total_changed_chars).toBeGreaterThanOrEqual(8);
  });
});
