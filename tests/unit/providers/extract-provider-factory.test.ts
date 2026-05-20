import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getExtractProvider,
  _resetExtractProviderForTest,
} from '../../../src/providers/extract-provider.js';
import { V1Extractor } from '../../../src/extraction/v1/extract-provider.js';

describe('getExtractProvider', () => {
  beforeEach(() => { _resetExtractProviderForTest(); });
  afterEach(() => { _resetExtractProviderForTest(); });

  it('returns V1Extractor', async () => {
    expect(await getExtractProvider()).toBeInstanceOf(V1Extractor);
  });

  it('memoizes the resolved provider', async () => {
    const a = await getExtractProvider();
    const b = await getExtractProvider();
    expect(a).toBe(b);
  });

  it('exposes v1 name', async () => {
    const p = await getExtractProvider();
    expect(p.name).toBe('v1');
  });
});
