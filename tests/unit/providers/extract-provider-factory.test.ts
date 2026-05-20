import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getExtractor,
  _resetExtractorForTest,
} from '../../../src/providers/extract-provider.js';
import { LegacyExtractProvider } from '../../../src/extraction/legacy-provider.js';

describe('getExtractor', () => {
  beforeEach(() => { _resetExtractorForTest(); });
  afterEach(() => { _resetExtractorForTest(); });

  it('returns LegacyExtractProvider', async () => {
    expect(await getExtractor()).toBeInstanceOf(LegacyExtractProvider);
  });

  it('memoizes the resolved provider', async () => {
    const a = await getExtractor();
    const b = await getExtractor();
    expect(a).toBe(b);
  });
});
