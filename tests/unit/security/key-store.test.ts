/**
 * Tests for the key-store module (SP4).
 *
 * These tests cover the fallback chain (keychain → file → env) and the
 * storeKey/readKey/deleteKey/listProviders actions. Keychain is mocked so
 * tests run in sandbox/CI without a live OS keychain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

// Mock the keychain binding before importing key-store
vi.mock('../../../src/security/keychain.js', () => {
  const store = new Map<string, string>();
  return {
    WIGOLO_SERVICE: 'wigolo',
    keychainAvailable: vi.fn(() => true),
    keychainSet: vi.fn((service: string, _user: string, value: string) => { store.set(service, value); }),
    keychainGet: vi.fn((service: string, _user: string) => store.get(service) ?? null),
    keychainDelete: vi.fn((service: string, _user: string) => { store.delete(service); }),
    _store: store,
  };
});

const keychainMod = await import('../../../src/security/keychain.js');
const { keychainAvailable, keychainSet, keychainGet, keychainDelete, _store } = keychainMod as typeof keychainMod & { _store: Map<string, string> };

const {
  storeKey,
  readKey,
  deleteKey,
  resolveProviderKey,
  listProviders,
  clearKeyStoreMemo,
} = await import('../../../src/security/key-store.js');

describe('keychain tier (keychainAvailable = true)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _store.clear();
    clearKeyStoreMemo();
    vi.mocked(keychainAvailable).mockReturnValue(true);
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-ks-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  it('storeKey stores in keychain and reads back', async () => {
    await storeKey('anthropic', 'sk-test-key', { dataDir: tmpDir });
    const result = await readKey('anthropic', { dataDir: tmpDir });
    expect(result).toEqual({ value: 'sk-test-key', location: 'keychain' });
  });

  it('deleteKey removes from keychain', async () => {
    await storeKey('openai', 'sk-openai-key', { dataDir: tmpDir });
    await deleteKey('openai', { dataDir: tmpDir });
    const result = await readKey('openai', { dataDir: tmpDir });
    expect(result).toBeNull();
  });

  it('resolveProviderKey returns keychain value without env hydration', async () => {
    await storeKey('gemini', 'gm-key', { dataDir: tmpDir });
    const originalEnv = { ...process.env };
    const resolved = await resolveProviderKey('gemini', { dataDir: tmpDir });
    expect(resolved).toBe('gm-key');
    // CRITICAL: env must NOT be mutated
    expect(process.env.GOOGLE_API_KEY).toBeUndefined();
    // Restore
    Object.assign(process.env, originalEnv);
  });

  it('resolveProviderKey falls through to env when keychain miss and no file', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-ant-key';
    const resolved = await resolveProviderKey('anthropic', { dataDir: tmpDir });
    expect(resolved).toBe('env-ant-key');
  });
});

describe('file fallback tier (keychainAvailable = false)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _store.clear();
    clearKeyStoreMemo();
    vi.mocked(keychainAvailable).mockReturnValue(false);
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-ks-file-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('stores in encrypted file when keychain unavailable', async () => {
    await storeKey('anthropic', 'sk-file-key', { dataDir: tmpDir });
    const result = await readKey('anthropic', { dataDir: tmpDir });
    expect(result).toEqual({ value: 'sk-file-key', location: 'file' });
  });

  it('deleteKey removes encrypted file', async () => {
    await storeKey('openai', 'sk-openai-file', { dataDir: tmpDir });
    await deleteKey('openai', { dataDir: tmpDir });
    const result = await readKey('openai', { dataDir: tmpDir });
    expect(result).toBeNull();
  });

  it('falls through to env when no file exists', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-fallback';
    const resolved = await resolveProviderKey('anthropic', { dataDir: tmpDir });
    expect(resolved).toBe('env-fallback');
  });
});

describe('listProviders', () => {
  let tmpDir: string;

  beforeEach(() => {
    _store.clear();
    clearKeyStoreMemo();
    vi.mocked(keychainAvailable).mockReturnValue(true);
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-list-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns providers with key stored', async () => {
    await storeKey('anthropic', 'k1', { dataDir: tmpDir });
    await storeKey('openai', 'k2', { dataDir: tmpDir });
    const list = await listProviders({ dataDir: tmpDir });
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'anthropic' }),
        expect.objectContaining({ provider: 'openai' }),
      ]),
    );
  });

  it('returns empty array when no providers stored', async () => {
    const list = await listProviders({ dataDir: tmpDir });
    expect(list).toEqual([]);
  });
});

describe('resolveProviderKey memo invalidation', () => {
  let tmpDir: string;

  beforeEach(() => {
    _store.clear();
    clearKeyStoreMemo();
    vi.mocked(keychainAvailable).mockReturnValue(true);
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-memo-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns the new value after storeKey (memo invalidated on store)', async () => {
    // First resolve: miss → memoized as null
    const first = await resolveProviderKey('anthropic', { dataDir: tmpDir });
    expect(first).toBeUndefined();

    // Store a key — must invalidate the memoized miss
    await storeKey('anthropic', 'new-key', { dataDir: tmpDir });

    const second = await resolveProviderKey('anthropic', { dataDir: tmpDir });
    expect(second).toBe('new-key');
  });

  it('returns updated value after re-keying (memo reflects the latest store)', async () => {
    await storeKey('openai', 'old-key', { dataDir: tmpDir });
    expect(await resolveProviderKey('openai', { dataDir: tmpDir })).toBe('old-key');

    // Re-key — memo must invalidate so the new value is returned
    await storeKey('openai', 'rotated-key', { dataDir: tmpDir });
    expect(await resolveProviderKey('openai', { dataDir: tmpDir })).toBe('rotated-key');
  });

  it('returns undefined after deleteKey (memo invalidated on delete)', async () => {
    await storeKey('gemini', 'gm-key', { dataDir: tmpDir });
    expect(await resolveProviderKey('gemini', { dataDir: tmpDir })).toBe('gm-key');

    await deleteKey('gemini', { dataDir: tmpDir });
    expect(await resolveProviderKey('gemini', { dataDir: tmpDir })).toBeUndefined();
  });

  it('memoizes a hit so a second resolve does not re-probe the keychain', async () => {
    await storeKey('anthropic', 'cached-key', { dataDir: tmpDir });
    // Prime the memo
    await resolveProviderKey('anthropic', { dataDir: tmpDir });
    const callsAfterFirst = vi.mocked(keychainGet).mock.calls.length;

    // Second resolve should hit the memo, not the keychain
    const result = await resolveProviderKey('anthropic', { dataDir: tmpDir });
    expect(result).toBe('cached-key');
    expect(vi.mocked(keychainGet).mock.calls.length).toBe(callsAfterFirst);
  });
});
