import { describe, it, expect } from 'vitest';
import { countTokens, truncateByTokens } from '../../../src/search/tokens.js';

describe('countTokens', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });
  it('returns positive count for prose', () => {
    expect(countTokens('The quick brown fox jumps over the lazy dog.')).toBeGreaterThan(5);
  });
  it('counts more tokens for longer text', () => {
    const short = countTokens('hello world');
    const long = countTokens('hello world '.repeat(50));
    expect(long).toBeGreaterThan(short);
  });
});

describe('truncateByTokens', () => {
  it('returns input unchanged when under budget', () => {
    const text = 'one two three four five';
    expect(truncateByTokens(text, 100)).toBe(text);
  });
  it('truncates at sentence boundary when possible', () => {
    const text = 'First sentence here. Second sentence here. Third sentence here. ' + 'filler '.repeat(200);
    const out = truncateByTokens(text, 30);
    expect(out.length).toBeLessThan(text.length);
    expect(out.endsWith('.') || out.endsWith('. ') || out.endsWith('truncated]')).toBe(true);
  });
  it('honours hard cap when no sentence boundary fits', () => {
    const text = 'x '.repeat(2000);
    const out = truncateByTokens(text, 20);
    expect(countTokens(out)).toBeLessThanOrEqual(20 + 6); // small slack for marker
  });
  it('returns marker when budget is 0', () => {
    expect(truncateByTokens('anything', 0)).toMatch(/truncated/);
  });
});
