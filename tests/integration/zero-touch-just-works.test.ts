/**
 * Zero-touch "just works" acceptance gate.
 *
 * Proves the spec invariant: with ZERO relevant env vars set, a fresh process
 * resolves search backend + LLM provider + LLM key purely from the persisted
 * config.json + key-store (keychain / file), and both the agent and research
 * pipeline gates report the LLM configured.
 *
 * Each assertion is annotated with the code it guards so a future regression
 * points at the right place:
 *   - search self-config:  getConfig()/getSearchProvider() read
 *     config.json `searchBackend` (src/config.ts, src/providers/search-provider.ts).
 *   - LLM self-config:     selectProviderWithKeyStore reads config.json
 *     `llmProvider` + keychain key (src/integrations/cloud/llm/select.ts,
 *     src/security/key-store.ts).
 *   - keystore-aware gate: isLlmConfiguredWithKeyStore consults the
 *     key-store, not just env (src/integrations/cloud/llm/run.ts) — used by
 *     both the research and agent pipelines.
 *   - init persistence:     the shape this test seeds (config.json
 *     `settings.{searchBackend,llmProvider}` + keychain key) is exactly
 *     what `wigolo init` writes (src/cli/init.ts).
 *
 * The seed is written through the SAME persisted-config + key-store APIs the
 * runtime reads, so it is a faithful stand-in for a post-`init` machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// In-memory keychain so storeKey/resolveProviderKey exercise the keychain tier
// deterministically without depending on a real OS keychain being present in
// the sandbox. This is the SAME seam the keystore-aware gate test uses.
vi.mock('../../src/security/keychain.js', () => {
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

const keychainMod = await import('../../src/security/keychain.js');
const { _store } = keychainMod as typeof keychainMod & { _store: Map<string, string> };
const { storeKey, resolveProviderKey, clearKeyStoreMemo } = await import('../../src/security/key-store.js');
const { selectProviderWithKeyStore } = await import('../../src/integrations/cloud/llm/select.js');
const { isLlmConfiguredWithKeyStore } = await import('../../src/integrations/cloud/llm/run.js');
const { getConfig, resetConfig } = await import('../../src/config.js');
const { resetPersistedConfig } = await import('../../src/persisted-config.js');
const { getSearchProvider, _resetSearchProviderForTest } = await import('../../src/providers/search-provider.js');
const { HybridSearchProvider } = await import('../../src/search/hybrid/router.js');
const { CoreSearchProvider } = await import('../../src/search/core/core-provider.js');

// Every env var that could short-circuit the config.json / keychain path.
// Cleared so the test proves "zero env" resolution; restored in afterEach.
const RELEVANT_ENV_VARS = [
  'WIGOLO_SEARCH',
  'WIGOLO_LLM_PROVIDER',
  'WIGOLO_LLM_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'WIGOLO_DATA_DIR',
  'WIGOLO_CONFIG_PATH',
];

describe('zero-touch "just works" acceptance gate (slices 1 + 1b + 2)', () => {
  const originalEnv = process.env;
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    // Snapshot then clear: a fresh process with none of the relevant vars set.
    process.env = { ...originalEnv };
    for (const v of RELEVANT_ENV_VARS) delete process.env[v];

    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-zero-touch-'));
    configPath = join(tmpDir, 'config.json');

    // dataDir + configPath both point at the temp dir so the key-store and the
    // persisted config agree — exactly the post-init on-disk layout.
    process.env.WIGOLO_DATA_DIR = tmpDir;
    process.env.WIGOLO_CONFIG_PATH = configPath;

    _store.clear();
    clearKeyStoreMemo();
    _resetSearchProviderForTest();
    resetConfig();
    resetPersistedConfig();

    // --- Seed: exactly what `wigolo init --provider=anthropic --search=hybrid`
    // with WIGOLO_LLM_API_KEY set persists. Non-secrets → config.json,
    // secret → key-store. The key value is NEVER written to config.json.
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        settings: { searchBackend: 'hybrid', llmProvider: 'anthropic' },
        provider: { name: 'anthropic', keyLocation: 'keychain' },
      }),
    );
    await storeKey('anthropic', 'sk-zero-touch-anthropic', { dataDir: tmpDir });

    // Re-read after seeding so caches reflect the seeded file.
    resetConfig();
    resetPersistedConfig();
    _resetSearchProviderForTest();
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
    _store.clear();
    clearKeyStoreMemo();
    _resetSearchProviderForTest();
    resetConfig();
    resetPersistedConfig();
    vi.restoreAllMocks();
  });

  it('resolves the search backend to hybrid from config.json with zero env', async () => {
    // The value the runtime reads (search-provider.ts uses getConfig().searchBackend).
    expect(getConfig().searchBackend).toBe('hybrid');

    // And the actual provider factory the server boots returns a hybrid provider.
    const provider = await getSearchProvider();
    expect(provider).toBeInstanceOf(HybridSearchProvider);
    expect(provider.name).toBe('hybrid');
  });

  it('resolves the LLM provider to anthropic and recovers the key from the key-store with zero env', async () => {
    const resolved = await selectProviderWithKeyStore(process.env, { dataDir: getConfig().dataDir });
    expect(resolved).not.toBeNull();
    expect(resolved!.provider).toBe('anthropic');
    expect(resolved!.key).toBe('sk-zero-touch-anthropic');

    // The key is independently retrievable through the keystore resolver.
    const key = await resolveProviderKey('anthropic', { dataDir: getConfig().dataDir });
    expect(key).toBe('sk-zero-touch-anthropic');
  });

  it('the agent + research pipeline gates both report the LLM configured with zero env', async () => {
    // Both pipelines call isLlmConfiguredWithKeyStore() with no args (env=process.env).
    // With env cleared, a true result can only come from config.json + keystore.
    await expect(isLlmConfiguredWithKeyStore()).resolves.toBe(true);
    // Explicit-env call shape (defensive): same result.
    await expect(isLlmConfiguredWithKeyStore(process.env)).resolves.toBe(true);
  });

  it('does NOT write the secret key into config.json (secret hygiene)', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(configPath, 'utf-8');
    expect(raw).not.toContain('sk-zero-touch-anthropic');
  });

  describe('env still wins over config.json (precedence guard)', () => {
    it('WIGOLO_SEARCH=core overrides config.json searchBackend=hybrid (precedence)', async () => {
      process.env.WIGOLO_SEARCH = 'core';
      _resetSearchProviderForTest();
      resetConfig();
      resetPersistedConfig();

      expect(getConfig().searchBackend).toBe('core');
      const provider = await getSearchProvider();
      expect(provider).toBeInstanceOf(CoreSearchProvider);
      expect(provider.name).toBe('core');
    });

    it('WIGOLO_LLM_PROVIDER=openai overrides config.json llmProvider=anthropic (precedence)', async () => {
      // Provide an openai key in the keystore so the explicit env provider resolves.
      await storeKey('openai', 'sk-zero-touch-openai', { dataDir: tmpDir });
      clearKeyStoreMemo();
      process.env.WIGOLO_LLM_PROVIDER = 'openai';
      resetConfig();
      resetPersistedConfig();

      const resolved = await selectProviderWithKeyStore(process.env, { dataDir: getConfig().dataDir });
      expect(resolved).not.toBeNull();
      expect(resolved!.provider).toBe('openai');
      expect(resolved!.key).toBe('sk-zero-touch-openai');
    });
  });
});
