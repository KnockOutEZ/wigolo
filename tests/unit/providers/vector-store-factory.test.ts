import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getVectorStore,
  _resetVectorStoreForTest,
} from '../../../src/providers/vector-store.js';
import { LegacyVectorStore } from '../../../src/cache/legacy-vector-store.js';

describe('getVectorStore', () => {
  beforeEach(() => { _resetVectorStoreForTest(); });
  afterEach(() => { _resetVectorStoreForTest(); });

  it('returns LegacyVectorStore', async () => {
    expect(await getVectorStore()).toBeInstanceOf(LegacyVectorStore);
  });

  it('memoizes the resolved provider', async () => {
    const a = await getVectorStore();
    const b = await getVectorStore();
    expect(a).toBe(b);
  });
});
