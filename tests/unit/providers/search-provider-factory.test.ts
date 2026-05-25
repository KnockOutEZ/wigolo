import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSearchProvider, _resetSearchProviderForTest } from '../../../src/providers/search-provider.js';
import { resetConfig } from '../../../src/config.js';
import { LegacySearxngProvider } from '../../../src/search/legacy/searxng-provider.js';
import { CoreSearchProvider } from '../../../src/search/core/core-provider.js';
import { HybridSearchProvider } from '../../../src/search/hybrid/router.js';

describe('getSearchProvider', () => {
  let originalEnv: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrOutput: string;

  beforeEach(() => {
    originalEnv = process.env.WIGOLO_SEARCH;
    _resetSearchProviderForTest();
    resetConfig();
    stderrOutput = '';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrOutput += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WIGOLO_SEARCH;
    else process.env.WIGOLO_SEARCH = originalEnv;
    _resetSearchProviderForTest();
    resetConfig();
    stderrSpy.mockRestore();
  });

  it('returns CoreSearchProvider by default (unset)', async () => {
    delete process.env.WIGOLO_SEARCH;
    const provider = await getSearchProvider();
    expect(provider).toBeInstanceOf(CoreSearchProvider);
    expect(provider.name).toBe('core');
  });

  it('returns CoreSearchProvider when WIGOLO_SEARCH=core', async () => {
    process.env.WIGOLO_SEARCH = 'core';
    const provider = await getSearchProvider();
    expect(provider).toBeInstanceOf(CoreSearchProvider);
    expect(provider.name).toBe('core');
  });

  it('returns LegacySearxngProvider when WIGOLO_SEARCH=searxng', async () => {
    process.env.WIGOLO_SEARCH = 'searxng';
    const provider = await getSearchProvider();
    expect(provider).toBeInstanceOf(LegacySearxngProvider);
    expect(provider.name).toBe('searxng');
  });

  it('returns HybridSearchProvider when WIGOLO_SEARCH=hybrid', async () => {
    process.env.WIGOLO_SEARCH = 'hybrid';
    const provider = await getSearchProvider();
    expect(provider).toBeInstanceOf(HybridSearchProvider);
    expect(provider.name).toBe('hybrid');
    expect(stderrOutput).not.toMatch(/not yet implemented/);
  });

  it('accepts deprecated WIGOLO_SEARCH=v1 as alias for core and warns', async () => {
    process.env.WIGOLO_SEARCH = 'v1';
    const provider = await getSearchProvider();
    expect(provider).toBeInstanceOf(CoreSearchProvider);
    expect(provider.name).toBe('core');
    expect(stderrOutput).toMatch(/deprecated/);
  });

  it('rejects on unknown value with vocabulary error', async () => {
    process.env.WIGOLO_SEARCH = 'garbage';
    await expect(getSearchProvider()).rejects.toThrow(/Unknown WIGOLO_SEARCH/);
  });

  it('recovers from prior rejection on next call', async () => {
    process.env.WIGOLO_SEARCH = 'garbage';
    await expect(getSearchProvider()).rejects.toThrow(/Unknown WIGOLO_SEARCH/);
    process.env.WIGOLO_SEARCH = 'searxng';
    expect(await getSearchProvider()).toBeInstanceOf(LegacySearxngProvider);
  });
});
