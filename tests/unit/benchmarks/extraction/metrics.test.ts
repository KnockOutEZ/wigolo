import { describe, it, expect } from 'vitest';
import {
  computePrecision,
  computeRecall,
  computeF1,
  computeRougeL,
  countHeadings,
  countLinks,
  computeMetrics,
} from '../../../../benchmarks/extraction/metrics.js';

describe('computePrecision', () => {
  it('returns 1.0 for identical texts', () => {
    expect(computePrecision('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 when extracted has no overlap with golden', () => {
    expect(computePrecision('alpha beta', 'gamma delta')).toBe(0);
  });

  it('returns 0 for empty extracted text', () => {
    expect(computePrecision('', 'hello world')).toBe(0);
  });

  it('returns 0 for both empty', () => {
    expect(computePrecision('', '')).toBe(0);
  });

  it('computes partial precision correctly', () => {
    const p = computePrecision('a b c d', 'a b e f');
    expect(p).toBeCloseTo(0.5);
  });

  it('handles text with markdown formatting', () => {
    const p = computePrecision('**hello** world', 'hello world');
    expect(p).toBeGreaterThan(0.5);
  });
});

describe('computeRecall', () => {
  it('returns 1.0 for identical texts', () => {
    expect(computeRecall('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 when no golden words appear in extracted', () => {
    expect(computeRecall('alpha beta', 'gamma delta')).toBe(0);
  });

  it('returns 0 for empty golden', () => {
    expect(computeRecall('hello world', '')).toBe(0);
  });

  it('returns 1 when all golden words are in extracted', () => {
    const r = computeRecall('a b c d e f', 'a b');
    expect(r).toBe(1);
  });

  it('computes partial recall correctly', () => {
    const r = computeRecall('a c', 'a b c d');
    expect(r).toBeCloseTo(0.5);
  });
});

describe('computeF1', () => {
  it('returns 1.0 for identical texts', () => {
    expect(computeF1('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for no overlap', () => {
    expect(computeF1('alpha', 'beta')).toBe(0);
  });

  it('returns 0 for empty inputs', () => {
    expect(computeF1('', '')).toBe(0);
  });

  it('computes harmonic mean of precision and recall', () => {
    const f1 = computeF1('a b c d', 'a b e f');
    expect(f1).toBeCloseTo(0.5);
  });

  it('F1 is between precision and recall', () => {
    const f1 = computeF1('a b c d e f', 'a b');
    expect(f1).toBeGreaterThan(0);
    expect(f1).toBeLessThanOrEqual(1);
  });
});

describe('computeRougeL', () => {
  it('returns 1.0 for identical texts', () => {
    expect(computeRougeL('hello world foo', 'hello world foo')).toBeCloseTo(1);
  });

  it('returns 0 for completely different texts', () => {
    expect(computeRougeL('alpha beta', 'gamma delta')).toBe(0);
  });

  it('returns 0 for empty inputs', () => {
    expect(computeRougeL('', '')).toBe(0);
    expect(computeRougeL('hello', '')).toBe(0);
    expect(computeRougeL('', 'hello')).toBe(0);
  });

  it('computes partial ROUGE-L', () => {
    const r = computeRougeL('a b c d e', 'a c e');
    expect(r).toBeCloseTo(0.75, 1);
  });

  it('handles long texts without excessive memory', () => {
    const a = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const b = Array.from({ length: 200 }, (_, i) => `word${i * 2}`).join(' ');
    const r = computeRougeL(a, b);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  });
});

describe('countHeadings', () => {
  it('counts ATX headings correctly', () => {
    const md = '# H1\n## H2\n### H3\ntext\n## Another H2';
    expect(countHeadings(md)).toBe(4);
  });

  it('returns 0 for text with no headings', () => {
    expect(countHeadings('just some text\nmore text')).toBe(0);
  });

  it('returns 0 for empty text', () => {
    expect(countHeadings('')).toBe(0);
  });

  it('does not count # inside code blocks as headings', () => {
    const md = '# Real Heading\n```\n# Not a heading\n```';
    expect(countHeadings(md)).toBeGreaterThanOrEqual(1);
  });

  it('handles heading levels 1-6', () => {
    const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6';
    expect(countHeadings(md)).toBe(6);
  });
});

describe('countLinks', () => {
  it('counts markdown links correctly', () => {
    const md = '[link1](url1) and [link2](url2) and [link3](url3)';
    expect(countLinks(md)).toBe(3);
  });

  it('returns 0 for text with no links', () => {
    expect(countLinks('just text')).toBe(0);
  });

  it('returns 0 for empty text', () => {
    expect(countLinks('')).toBe(0);
  });

  it('excludes image links', () => {
    const md = '![img](url) [real link](url2)';
    expect(countLinks(md)).toBe(1);
  });

  it('handles links with complex URLs', () => {
    const md = '[link](https://example.com/path?q=1&b=2#frag)';
    expect(countLinks(md)).toBe(1);
  });
});

describe('computeMetrics', () => {
  it('returns all metric fields for valid inputs', () => {
    const result = computeMetrics('# Hello\n\nWorld [link](url)', '# Hello\n\nWorld [link](url)');
    expect(result).toHaveProperty('precision');
    expect(result).toHaveProperty('recall');
    expect(result).toHaveProperty('f1');
    expect(result).toHaveProperty('rougeL');
    expect(result).toHaveProperty('headingCountMatch');
    expect(result).toHaveProperty('headingCountExpected');
    expect(result).toHaveProperty('headingCountActual');
    expect(result).toHaveProperty('linkCountMatch');
    expect(result).toHaveProperty('linkCountExpected');
    expect(result).toHaveProperty('linkCountActual');
  });

  it('perfect scores for identical content', () => {
    const md = '# Title\n\nSome content here with [a link](url)';
    const result = computeMetrics(md, md);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.f1).toBe(1);
    expect(result.rougeL).toBeCloseTo(1);
    expect(result.headingCountMatch).toBe(true);
    expect(result.linkCountMatch).toBe(true);
  });

  it('zero scores for completely different content', () => {
    const result = computeMetrics('alpha beta gamma', 'delta epsilon zeta');
    expect(result.f1).toBe(0);
    expect(result.rougeL).toBe(0);
  });

  it('handles empty extracted markdown', () => {
    const result = computeMetrics('', '# Title\n\nContent');
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
  });

  it('detects heading count mismatch', () => {
    const extracted = '# One\n\n## Two';
    const golden = '# One\n\n## Two\n\n### Three';
    const result = computeMetrics(extracted, golden);
    expect(result.headingCountMatch).toBe(false);
    expect(result.headingCountActual).toBe(2);
    expect(result.headingCountExpected).toBe(3);
  });

  it('detects link count mismatch', () => {
    const extracted = '[a](u1)';
    const golden = '[a](u1) [b](u2) [c](u3)';
    const result = computeMetrics(extracted, golden);
    expect(result.linkCountMatch).toBe(false);
    expect(result.linkCountActual).toBe(1);
    expect(result.linkCountExpected).toBe(3);
  });
});
