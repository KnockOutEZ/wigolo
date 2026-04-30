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
  it('truncates at sentence boundary in the last 30% of the budget', () => {
    // Three sentences fit in budget; tail filler forces truncation.
    const head = 'First sentence here. Second sentence here. Third sentence here.';
    const text = head + ' ' + 'filler '.repeat(400);
    const out = truncateByTokens(text, 21);
    // Must end at a sentence boundary, not a hard word cut.
    expect(out).toMatch(/here\.[\s\S]*\[\.\.\. content truncated\]$/);
    // Must not have crossed into the filler region beyond the third sentence.
    expect(out.includes('filler')).toBe(false);
  });

  it('falls back to paragraph boundary when no sentence boundary fits the budget', () => {
    const para1 = 'word '.repeat(40); // ~40 tokens, no sentence punctuation
    const para2 = 'tail '.repeat(40);
    const text = para1 + '\n\n' + para2;
    const out = truncateByTokens(text, 30);
    expect(out).toMatch(/\[\.\.\. content truncated\]$/);
    expect(out.includes('tail')).toBe(false);
    // Must contain a paragraph break before the marker
    expect(out.includes('\n\n[... content truncated]')).toBe(true);
  });

  it('falls back to heading boundary when no sentence/paragraph boundary fits', () => {
    const intro = 'word '.repeat(60); // long, no punctuation, no blank line
    const text = intro + '\n# Heading\n' + 'tail '.repeat(60);
    const out = truncateByTokens(text, 80);
    expect(out).toMatch(/\[\.\.\. content truncated\]$/);
    expect(out.includes('tail')).toBe(false);
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
