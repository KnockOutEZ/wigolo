/**
 * Tests for selectProviderWithKeyStore — the seam that makes keychain/file
 * keys visible to selectProvider without hydrating process.env (SP4 blocker B2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

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
const { resetConfig } = await import('../../../src/config.js');
const { resetPersistedConfig } = await import('../../../src/persisted-config.js');

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
    delete process.env.WIGOLO_LLM_API_KEY;
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

  it('resolves explicit provider via WIGOLO_LLM_API_KEY when no provider-specific var (#102)', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'gemini';
    process.env.WIGOLO_LLM_API_KEY = 'AIza-llm-key';
    const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
    expect(result?.provider).toBe('gemini');
    expect(result?.key).toBe('AIza-llm-key');
  });

  it('provider-specific var wins over WIGOLO_LLM_API_KEY for explicit provider', async () => {
    process.env.WIGOLO_LLM_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'google-specific';
    process.env.WIGOLO_LLM_API_KEY = 'generic-llm';
    const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
    expect(result?.provider).toBe('gemini');
    expect(result?.key).toBe('google-specific');
  });

  it('ignores WIGOLO_LLM_API_KEY during auto-detect (no explicit provider)', async () => {
    process.env.WIGOLO_LLM_API_KEY = 'AIza-llm-key';
    const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
    expect(result).toBeNull();
  });

  it('returns null for the ollama alias (keyless custom backend, handled in run.ts)', async () => {
    // WHY: ollama has no API key. If select returned a cloud provider here, a
    // user with ollama configured but a stray cloud key would be silently
    // routed to the cloud instead of their local server.
    await storeKey('anthropic', 'an-key', { dataDir: tmpDir });
    process.env.WIGOLO_LLM_PROVIDER = 'ollama';
    const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
    expect(result).toBeNull();
  });

  it('does not mutate process.env', async () => {
    await storeKey('anthropic', 'kc-key', { dataDir: tmpDir });
    const envSnapshot = JSON.stringify(process.env);
    await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
    expect(JSON.stringify(process.env)).toBe(envSnapshot);
  });

  describe('config.json llmProvider precedence (A2)', () => {
    afterEach(() => {
      delete process.env.WIGOLO_CONFIG_PATH;
      resetConfig();
      resetPersistedConfig();
    });

    function writeConfig(provider: string): void {
      const cfgPath = join(tmpDir, 'config.json');
      writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { llmProvider: provider } }));
      process.env.WIGOLO_CONFIG_PATH = cfgPath;
      resetConfig();
      resetPersistedConfig();
    }

    it('uses config.json llmProvider when WIGOLO_LLM_PROVIDER env is absent', async () => {
      await storeKey('gemini', 'gm-key', { dataDir: tmpDir });
      // anthropic has a key too, but config.json names gemini explicitly
      await storeKey('anthropic', 'an-key', { dataDir: tmpDir });
      writeConfig('gemini');
      const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
      expect(result?.provider).toBe('gemini');
      expect(result?.key).toBe('gm-key');
    });

    it('WIGOLO_LLM_PROVIDER env wins over config.json llmProvider', async () => {
      await storeKey('gemini', 'gm-key', { dataDir: tmpDir });
      await storeKey('openai', 'oa-key', { dataDir: tmpDir });
      writeConfig('gemini');
      process.env.WIGOLO_LLM_PROVIDER = 'openai';
      const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
      expect(result?.provider).toBe('openai');
      expect(result?.key).toBe('oa-key');
    });

    it('falls through to auto-detect when config.json provider has no key', async () => {
      // config names anthropic but only openai has a key
      await storeKey('openai', 'oa-key', { dataDir: tmpDir });
      writeConfig('anthropic');
      const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
      expect(result?.provider).toBe('openai');
    });
  });

  describe('zero-env runtime invariant (A1+A2+A3)', () => {
    afterEach(() => {
      delete process.env.WIGOLO_CONFIG_PATH;
      resetConfig();
      resetPersistedConfig();
    });

    it('resolves provider=anthropic + keychain key from config.json with ZERO env vars', async () => {
      // No WIGOLO_LLM_PROVIDER, no ANTHROPIC_API_KEY (cleared in beforeEach).
      await storeKey('anthropic', 'kc-anthropic-key', { dataDir: tmpDir });
      const cfgPath = join(tmpDir, 'config.json');
      writeFileSync(
        cfgPath,
        JSON.stringify({ version: 1, settings: { searchBackend: 'hybrid', llmProvider: 'anthropic' } }),
      );
      process.env.WIGOLO_CONFIG_PATH = cfgPath;
      resetConfig();
      resetPersistedConfig();

      const result = await selectProviderWithKeyStore(process.env, { dataDir: tmpDir });
      expect(result?.provider).toBe('anthropic');
      expect(result?.key).toBe('kc-anthropic-key');
    });
  });
});
