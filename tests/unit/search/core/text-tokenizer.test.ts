import { describe, expect, it } from 'vitest';
import { tokenizeRankingText } from '../../../../src/search/core/text-tokenizer.js';

describe('tokenizeRankingText', () => {
  it('preserves Latin and digit runs while emitting CJK bigrams', () => {
    expect(tokenizeRankingText('Hermes Agent 中文配置 2026')).toEqual([
      'hermes',
      'agent',
      '中文',
      '文配',
      '配置',
      '2026',
    ]);
  });

  it('keeps Japanese prolonged sound marks inside Katakana bigrams', () => {
    expect(tokenizeRankingText('AIニュース')).toEqual(['ai', 'ニュ', 'ュー', 'ース']);
  });

  it('emits Hangul bigrams for unsegmented Korean text', () => {
    expect(tokenizeRankingText('인공지능뉴스')).toEqual(['인공', '공지', '지능', '능뉴', '뉴스']);
  });

  it('caps token output for pathological unsegmented input', () => {
    const tokens = tokenizeRankingText('中'.repeat(10_000_000));

    expect(tokens.length).toBeLessThanOrEqual(256);
  });
});