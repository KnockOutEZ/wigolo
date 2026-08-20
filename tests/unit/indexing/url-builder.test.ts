import { describe, it, expect } from 'vitest';
import { buildInternalUrl, titleFromMarkdown } from '../../../src/indexing/url-builder.js';

describe('buildInternalUrl', () => {
  it('lowercases namespace and encodes path segments', () => {
    expect(buildInternalUrl('Docs', 'arch/ADR 1.md')).toBe(
      'internal://docs/arch/ADR%201.md',
    );
  });

  it('defaults empty namespace to docs', () => {
    expect(buildInternalUrl('', 'readme.md')).toBe('internal://docs/readme.md');
  });

  it('rejects namespace with path separators', () => {
    expect(() => buildInternalUrl('bad/name', 'x.md')).toThrow(/invalid namespace/i);
  });

  it('rejects namespace with URL delimiters, spaces, or colons', () => {
    expect(() => buildInternalUrl('docs extra', 'x.md')).toThrow(/invalid namespace/i);
    expect(() => buildInternalUrl('docs:1', 'x.md')).toThrow(/invalid namespace/i);
    expect(() => buildInternalUrl('docs#frag', 'x.md')).toThrow(/invalid namespace/i);
    expect(() => buildInternalUrl('user@docs', 'x.md')).toThrow(/invalid namespace/i);
  });
});

describe('titleFromMarkdown', () => {
  it('prefers the first ATX H1', () => {
    expect(titleFromMarkdown('# Hello\n\nbody', 'file.md')).toBe('Hello');
    expect(titleFromMarkdown('no heading', 'file.md')).toBe('file');
  });
});
