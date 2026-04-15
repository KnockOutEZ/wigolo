import { describe, expect, it } from 'vitest';
import {
  suggestionFor,
  suggestionsFromResult,
  type VerifyCheckId,
} from '../../../../src/cli/tui/verify-suggestions.js';
import type { VerifyResult } from '../../../../src/cli/tui/verify.js';

describe('suggestionFor', () => {
  const table: Array<[VerifyCheckId, RegExp]> = [
    ['searxng', /wigolo warmup --force/],
    ['test-search', /SearXNG/],
    ['flashrank', /wigolo warmup/],
    ['trafilatura', /wigolo warmup/],
    ['embeddings', /wigolo warmup/],
  ];

  for (const [id, pattern] of table) {
    it(`returns a non-empty suggestion for ${id}`, () => {
      const msg = suggestionFor(id);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).toMatch(pattern);
    });
  }
});

describe('suggestionsFromResult', () => {
  const okResult: VerifyResult = {
    searxng: 'ok',
    searxngUrl: 'http://127.0.0.1:8888',
    testSearch: 'ok',
    testSearchCount: 3,
    flashrank: 'ok',
    trafilatura: 'ok',
    embeddings: 'ok',
    embeddingsDim: 384,
    allPassed: true,
  };

  it('returns empty array when everything passed', () => {
    expect(suggestionsFromResult(okResult)).toEqual([]);
  });

  it('emits one suggestion per failing check', () => {
    const failing: VerifyResult = {
      ...okResult,
      searxng: 'failed',
      testSearch: 'skipped',
      flashrank: 'missing',
      trafilatura: 'ok',
      embeddings: 'missing',
      allPassed: false,
    };
    const msgs = suggestionsFromResult(failing);
    expect(msgs).toHaveLength(3);
    expect(msgs.some(m => m.includes('wigolo warmup --force'))).toBe(true);
    expect(msgs.some(m => m.includes('FlashRank'))).toBe(true);
    expect(msgs.some(m => m.includes('Embeddings'))).toBe(true);
  });

  it('treats test-search skipped as a suggestion only when searxng is also failed', () => {
    const failing: VerifyResult = {
      ...okResult,
      searxng: 'failed',
      testSearch: 'skipped',
      allPassed: false,
    };
    const msgs = suggestionsFromResult(failing);
    expect(msgs.filter(m => m.toLowerCase().includes('searxng')).length).toBeGreaterThan(0);
  });
});
