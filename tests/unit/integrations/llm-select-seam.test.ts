/**
 * Tests for selectProviderWithKeyStore — the seam that makes keychain/file
 * keys visible to selectProvider without hydrating process.env (SP4 blocker B2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

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
const { _store } = keychainMod as typeof keychainMod & { _store: Map<string, string> };

const { storeKey, clearKeyStoreMemo } = await import('../../../src/security/key-store.js');
const { selectProviderWithKeyStore } = await import('../../../src/integrations/cloud/llm/select.js');

describe('selectProviderWithKeyStore', () => {
  let tmpDir: string;
  const origEnv = process.env;

  beforeEach(() => {
    _store.clear();
    clearKeyStoreMemo();
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-select-test-'));
    process.env = { ...origEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.WIGOLO_LLM_PROVIDER;
  });

  afterEach(() => {
    process.env = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('selects provider whose key lives in keychain (not env)', async () => {
    await storeKey('openai', 'sk-keychain-key', { dataDir: tmpDir });
    const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
    expect(result?.provider).toBe('openai');
    // Env must NOT be contaminated
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it('honors WIGOLO_LLM_PROVIDER override when key resolves', async () => {
    await storeKey('gemini', 'gm-key', { dataDir: tmpDir });
    process.env.WIGOLO_LLM_PROVIDER = 'gemini';
    const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
    expect(result?.provider).toBe('gemini');
  });

  it('falls back to env-keyed provider when no keystore match', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
    expect(result?.provider).toBe('anthropic');
    expect(result?.key).toBe('env-key');
  });

  it('returns null when neither keystore nor env has a key', async () => {
    const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
    expect(result).toBeNull();
  });

  it('does not mutate process.env', async () => {
    await storeKey('anthropic', 'kc-key', { dataDir: tmpDir });
    const envSnapshot = JSON.stringify(process.env);
    await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
    expect(JSON.stringify(process.env)).toBe(envSnapshot);
  });
});
