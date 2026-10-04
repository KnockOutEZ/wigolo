import { describe, it, expect } from 'vitest';
import { buildQueryUnderstanding } from '../../../../src/search/core/query-understanding.js';

describe('buildQueryUnderstanding language detection', () => {
  it('detects Arabic queries as ar', () => {
    expect(buildQueryUnderstanding('ما أحدث أخبار الذكاء الاصطناعي في مصر؟').language).toBe('ar');
  });

  it('detects English queries as en', () => {
    expect(buildQueryUnderstanding('latest artificial intelligence news in Egypt').language).toBe('en');
  });

  it('preserves an explicit language override', () => {
    expect(buildQueryUnderstanding('ما أحدث أخبار الذكاء الاصطناعي؟', { language: 'ar' }).language).toBe('ar');
    expect(buildQueryUnderstanding('latest AI news', { language: 'custom' }).language).toBe('custom');
  });
});
