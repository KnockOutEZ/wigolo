import { describe, it, expect } from 'vitest';
import { truncateSmartly } from '../../../src/search/truncate.js';

describe('truncateSmartly', () => {
  it('returns input unchanged when under limit', () => {
    const text = 'short text';
    expect(truncateSmartly(text, 100)).toBe(text);
  });

  it('returns input unchanged when equal to limit', () => {
    const text = 'x'.repeat(100);
    expect(truncateSmartly(text, 100)).toBe(text);
  });

  it('cuts at paragraph break when inside 70% threshold', () => {
    const para1 = 'First paragraph.';
    const para2 = 'x'.repeat(500);
    const text = `${para1}\n\n${para2}`;
    const out = truncateSmartly(text, 100);

    // paragraph break at index 16; 70% of 100 = 70; break at 16 is BELOW threshold so hard cut applies
    expect(out.endsWith('[... content truncated]')).toBe(true);
  });

  it('cuts at paragraph break when near the limit (above 70%)', () => {
    const prefix = 'x'.repeat(80);
    const suffix = 'y'.repeat(500);
    const text = `${prefix}\n\n${suffix}`;
    const out = truncateSmartly(text, 100);

    expect(out).toContain(prefix);
    expect(out).not.toContain('yyyy');
    expect(out.endsWith('[... content truncated]')).toBe(true);
  });

  it('cuts at heading boundary when near limit', () => {
    const prefix = 'x'.repeat(80);
    const suffix = 'y'.repeat(500);
    const text = `${prefix}\n# Heading\n${suffix}`;
    const out = truncateSmartly(text, 100);

    // last heading break before 100 is at index 80
    expect(out).toContain(prefix);
    expect(out).not.toContain('yyyy');
    expect(out.endsWith('[... content truncated]')).toBe(true);
  });

  it('hard-cuts with marker when no suitable break within threshold', () => {
    const text = 'x'.repeat(500);
    const out = truncateSmartly(text, 100);

    expect(out.length).toBe(100 + '\n\n[... content truncated]'.length);
    expect(out.endsWith('[... content truncated]')).toBe(true);
  });

  it('prefers the later of paragraph vs heading break', () => {
    const text = 'a'.repeat(50) + '\n\n' + 'b'.repeat(30) + '\n# Header\n' + 'c'.repeat(500);
    // \n\n at 50; \n# at 82 → prefer 82 (later)
    const out = truncateSmartly(text, 100);
    expect(out).toContain('b'.repeat(30));
    expect(out).not.toContain('cccc');
  });

  it('handles empty string', () => {
    expect(truncateSmartly('', 100)).toBe('');
  });

  it('handles maxChars = 0 by hard-truncating with marker', () => {
    const text = 'hello world';
    const out = truncateSmartly(text, 0);
    expect(out).toBe('\n\n[... content truncated]');
  });
});
