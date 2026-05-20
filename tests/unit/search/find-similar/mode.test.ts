import { describe, it, expect } from 'vitest';
import { selectMode } from '../../../../src/search/find-similar/mode.js';
import type { FindSimilarInput } from '../../../../src/types.js';

describe('selectMode', () => {
  it('returns cache when no mode given (default)', () => {
    const input: FindSimilarInput = { url: 'https://example.com' };
    expect(selectMode(input)).toBe('cache');
  });

  it('returns cache when mode=auto (auto falls through to legacy flow)', () => {
    const input: FindSimilarInput = { url: 'https://example.com', mode: 'auto' };
    expect(selectMode(input)).toBe('cache');
  });

  it('returns cache when mode=cache is explicit', () => {
    const input: FindSimilarInput = { url: 'https://example.com', mode: 'cache' };
    expect(selectMode(input)).toBe('cache');
  });

  it('returns web-expansion when explicit', () => {
    const input: FindSimilarInput = { concept: 'react hooks', mode: 'web-expansion' };
    expect(selectMode(input)).toBe('web-expansion');
  });

  it('returns crawl-rank when mode=crawl-rank with a url', () => {
    const input: FindSimilarInput = { url: 'https://example.com', mode: 'crawl-rank' };
    expect(selectMode(input)).toBe('crawl-rank');
  });

  it('downgrades crawl-rank to cache when no url (concept-only cannot crawl)', () => {
    const input: FindSimilarInput = { concept: 'react hooks', mode: 'crawl-rank' };
    expect(selectMode(input)).toBe('cache');
  });

  it('downgrades crawl-rank to cache when url is empty string', () => {
    const input: FindSimilarInput = { url: '', mode: 'crawl-rank' };
    expect(selectMode(input)).toBe('cache');
  });

  it('downgrades crawl-rank to cache when url is whitespace', () => {
    const input: FindSimilarInput = { url: '   ', mode: 'crawl-rank' };
    expect(selectMode(input)).toBe('cache');
  });

  it('returns cache for concept-only with no mode', () => {
    const input: FindSimilarInput = { concept: 'react hooks' };
    expect(selectMode(input)).toBe('cache');
  });

  it('respects explicit mode even when both url and concept are present', () => {
    const input: FindSimilarInput = {
      url: 'https://example.com',
      concept: 'react',
      mode: 'crawl-rank',
    };
    expect(selectMode(input)).toBe('crawl-rank');
  });
});
