import { describe, it, expect } from 'vitest';
import { hashPrompt, hashSchema } from '../../../../src/extraction/llm/hash.js';

describe('hashPrompt', () => {
  it('is stable under whitespace variation', () => {
    expect(hashPrompt('hello   world')).toBe(hashPrompt(' hello\nworld '));
  });
  it('differs when content differs', () => {
    expect(hashPrompt('a')).not.toBe(hashPrompt('b'));
  });
  it('returns hex digest of stable length', () => {
    expect(hashPrompt('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashSchema', () => {
  it('is stable under key reordering', () => {
    const a = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    };
    const b = {
      properties: { b: { type: 'number' }, a: { type: 'string' } },
      type: 'object',
    };
    expect(hashSchema(a)).toBe(hashSchema(b));
  });
  it('handles nested objects deeply', () => {
    const a = { x: { y: { z: 1, w: 2 } } };
    const b = { x: { y: { w: 2, z: 1 } } };
    expect(hashSchema(a)).toBe(hashSchema(b));
  });
  it('preserves array order (semantic difference)', () => {
    expect(hashSchema({ enum: ['a', 'b'] })).not.toBe(
      hashSchema({ enum: ['b', 'a'] }),
    );
  });
  it('changes when shape changes', () => {
    expect(hashSchema({ type: 'object' })).not.toBe(
      hashSchema({ type: 'string' }),
    );
  });
});
