import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getEmbedProvider,
  _resetEmbedProviderForTest,
} from '../../../src/providers/embed-provider.js';
import { LegacyEmbedProvider } from '../../../src/embedding/legacy-provider.js';

describe('getEmbedProvider', () => {
  beforeEach(() => { _resetEmbedProviderForTest(); });
  afterEach(() => { _resetEmbedProviderForTest(); });

  it('returns LegacyEmbedProvider', async () => {
    expect(await getEmbedProvider()).toBeInstanceOf(LegacyEmbedProvider);
  });

  it('memoizes the resolved provider', async () => {
    const a = await getEmbedProvider();
    const b = await getEmbedProvider();
    expect(a).toBe(b);
  });
});
