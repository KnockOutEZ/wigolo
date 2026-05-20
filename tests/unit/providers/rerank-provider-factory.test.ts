import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getRerankProvider,
  _resetRerankProviderForTest,
} from '../../../src/providers/rerank-provider.js';
import { LegacyRerankProvider } from '../../../src/search/reranker/legacy-provider.js';

describe('getRerankProvider', () => {
  beforeEach(() => { _resetRerankProviderForTest(); });
  afterEach(() => { _resetRerankProviderForTest(); });

  it('returns LegacyRerankProvider', async () => {
    expect(await getRerankProvider()).toBeInstanceOf(LegacyRerankProvider);
  });

  it('memoizes the resolved provider', async () => {
    const a = await getRerankProvider();
    const b = await getRerankProvider();
    expect(a).toBe(b);
  });
});
