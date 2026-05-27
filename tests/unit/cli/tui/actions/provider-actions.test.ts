/**
 * Tests for SP4 provider actions: storeKey, readKey, deleteKey, listProviders.
 * These are thin wrappers around key-store; here we verify the action contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

vi.mock('../../../../../src/security/keychain.js', () => {
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

const keychainMod = await import('../../../../../src/security/keychain.js');
const { _store } = keychainMod as typeof keychainMod & { _store: Map<string, string> };

const {
  storeProviderKey,
  readProviderKey,
  deleteProviderKey,
  listConfiguredProviders,
} = await import('../../../../../src/cli/tui/actions/provider-keys.js');

describe('provider actions (SP4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _store.clear();
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-pa-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('storeProviderKey returns ok status', async () => {
    const result = await storeProviderKey('anthropic', 'sk-ant-test', { dataDir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.location).toBeDefined();
  });

  it('readProviderKey returns masked value and location', async () => {
    await storeProviderKey('openai', 'sk-openai-12345678', { dataDir: tmpDir });
    const result = await readProviderKey('openai', { dataDir: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.location).toBe('keychain');
    // Masked value should hide the secret
    expect(result!.masked).not.toContain('sk-openai-12345678');
    expect(result!.masked).toMatch(/\*/);
  });

  it('readProviderKey returns null when no key stored', async () => {
    const result = await readProviderKey('gemini', { dataDir: tmpDir });
    expect(result).toBeNull();
  });

  it('deleteProviderKey removes key', async () => {
    await storeProviderKey('openai', 'sk-delete-me', { dataDir: tmpDir });
    const del = await deleteProviderKey('openai', { dataDir: tmpDir });
    expect(del.ok).toBe(true);
    const after = await readProviderKey('openai', { dataDir: tmpDir });
    expect(after).toBeNull();
  });

  it('listConfiguredProviders returns configured providers', async () => {
    await storeProviderKey('anthropic', 'k1', { dataDir: tmpDir });
    await storeProviderKey('gemini', 'k2', { dataDir: tmpDir });
    const list = await listConfiguredProviders({ dataDir: tmpDir });
    const providers = list.map((p) => p.provider);
    expect(providers).toContain('anthropic');
    expect(providers).toContain('gemini');
  });

  it('keys are never exposed in list result', async () => {
    await storeProviderKey('anthropic', 'super-secret-key', { dataDir: tmpDir });
    const list = await listConfiguredProviders({ dataDir: tmpDir });
    const json = JSON.stringify(list);
    expect(json).not.toContain('super-secret-key');
  });
});
