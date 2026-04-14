import { describe, it, expect } from 'vitest';
import {
  tokenize,
  normalizeText,
  computeNGrams,
  longestCommonSubsequence,
  tokenOverlap,
} from '../../../../benchmarks/extraction/tokenizer.js';

describe('normalizeText', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeText('  Hello   World  ')).toBe('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeText('')).toBe('');
  });

  it('handles null/undefined gracefully', () => {
    expect(normalizeText(null as unknown as string)).toBe('');
    expect(normalizeText(undefined as unknown as string)).toBe('');
  });

  it('strips markdown formatting characters', () => {
    const input = '**bold** _italic_ `code` [link](url)';
    const result = normalizeText(input);
    expect(result).not.toContain('**');
    expect(result).not.toContain('_');
    expect(result).toContain('bold');
    expect(result).toContain('italic');
  });

  it('normalizes unicode whitespace', () => {
    expect(normalizeText('hello\u00a0world\u2003test')).toBe('hello world test');
  });

  it('removes heading markers', () => {
    expect(normalizeText('## Heading Text')).toBe('heading text');
  });
});

describe('tokenize', () => {
  it('splits text into word tokens', () => {
    expect(tokenize('hello world foo')).toEqual(['hello', 'world', 'foo']);
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles punctuation by splitting around it', () => {
    const tokens = tokenize('hello, world. foo-bar');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('foo');
    expect(tokens).toContain('bar');
  });

  it('handles text with only whitespace', () => {
    expect(tokenize('   \n\t  ')).toEqual([]);
  });

  it('preserves code tokens', () => {
    const tokens = tokenize('function myFunc() { return 42; }');
    expect(tokens).toContain('function');
    expect(tokens).toContain('myfunc');
    expect(tokens).toContain('return');
    expect(tokens).toContain('42');
  });
});

describe('computeNGrams', () => {
  it('computes bigrams from token list', () => {
    const tokens = ['a', 'b', 'c', 'd'];
    const bigrams = computeNGrams(tokens, 2);
    expect(bigrams).toEqual(['a b', 'b c', 'c d']);
  });

  it('returns empty for tokens shorter than n', () => {
    expect(computeNGrams(['a'], 2)).toEqual([]);
  });

  it('returns single element for tokens of length n', () => {
    expect(computeNGrams(['a', 'b'], 2)).toEqual(['a b']);
  });

  it('computes trigrams', () => {
    const tokens = ['a', 'b', 'c', 'd'];
    const trigrams = computeNGrams(tokens, 3);
    expect(trigrams).toEqual(['a b c', 'b c d']);
  });

  it('handles empty token array', () => {
    expect(computeNGrams([], 2)).toEqual([]);
  });
});

describe('longestCommonSubsequence', () => {
  it('finds LCS length for identical sequences', () => {
    const tokens = ['a', 'b', 'c'];
    expect(longestCommonSubsequence(tokens, tokens)).toBe(3);
  });

  it('returns 0 for completely different sequences', () => {
    expect(longestCommonSubsequence(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('handles empty sequences', () => {
    expect(longestCommonSubsequence([], ['a'])).toBe(0);
    expect(longestCommonSubsequence(['a'], [])).toBe(0);
    expect(longestCommonSubsequence([], [])).toBe(0);
  });

  it('finds correct LCS for partial overlap', () => {
    const a = ['a', 'b', 'c', 'd', 'e'];
    const b = ['a', 'c', 'e'];
    expect(longestCommonSubsequence(a, b)).toBe(3);
  });

  it('handles single-element sequences', () => {
    expect(longestCommonSubsequence(['a'], ['a'])).toBe(1);
    expect(longestCommonSubsequence(['a'], ['b'])).toBe(0);
  });
});

describe('tokenOverlap', () => {
  it('returns 1 for identical token sets', () => {
    const tokens = ['hello', 'world'];
    const result = tokenOverlap(tokens, tokens);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
  });

  it('returns 0 precision and recall for no overlap', () => {
    const result = tokenOverlap(['a', 'b'], ['c', 'd']);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
  });

  it('handles empty extracted tokens', () => {
    const result = tokenOverlap([], ['a', 'b']);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
  });

  it('handles empty golden tokens', () => {
    const result = tokenOverlap(['a', 'b'], []);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
  });

  it('computes correct partial overlap', () => {
    const extracted = ['a', 'b', 'c', 'd'];
    const golden = ['a', 'b', 'e', 'f'];
    const result = tokenOverlap(extracted, golden);
    expect(result.precision).toBe(0.5);
    expect(result.recall).toBe(0.5);
  });

  it('handles precision != recall when sizes differ', () => {
    const extracted = ['a', 'b', 'c', 'd', 'e', 'f'];
    const golden = ['a', 'b'];
    const result = tokenOverlap(extracted, golden);
    expect(result.precision).toBeCloseTo(2 / 6);
    expect(result.recall).toBe(1);
  });
});
