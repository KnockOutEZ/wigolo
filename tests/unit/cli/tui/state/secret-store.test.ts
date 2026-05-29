/**
 * Tests for the TUI default SecretStore. Keychain is mocked so the tests
 * exercise both tiers (keychain hit + file fallback) deterministically
 * without touching the real OS keychain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the keychain wrapper BEFORE importing the secret store.
vi.mock('../../../../../src/security/keychain.js', () => {
  const store = new Map<string, string>();
  let available = true;
  let throwOnSet = false;
  return {
    WIGOLO_SERVICE: 'wigolo',
    keychainAvailable: vi.fn(() => available),
    keychainSet: vi.fn((service: string, _user: string, value: string) => {
      if (throwOnSet) throw new Error('sandboxed keychain');
      store.set(service, value);
    }),
    keychainGet: vi.fn((service: string, _user: string) => store.get(service) ?? null),
    keychainDelete: vi.fn((service: string, _user: string) => { store.delete(service); }),
    _resetKeychainAvailability: vi.fn(),
    _store: store,
    _setAvailable: (v: boolean) => { available = v; },
    _setThrowOnSet: (v: boolean) => { throwOnSet = v; },
  };
});

const keychainMod = await import('../../../../../src/security/keychain.js');
const { _store, _setAvailable, _setThrowOnSet } = keychainMod as typeof keychainMod & {
  _store: Map<string, string>;
  _setAvailable: (v: boolean) => void;
  _setThrowOnSet: (v: boolean) => void;
};

const { defaultSecretStore } = await import('../../../../../src/cli/tui/state/secret-store.js');

describe('defaultSecretStore — keychain tier', () => {
  let tmp: string;

  beforeEach(() => {
    _store.clear();
    _setAvailable(true);
    _setThrowOnSet(false);
    tmp = mkdtempSync(join(tmpdir(), 'wigolo-ss-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('set returns location: keychain when keychain is available', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    const result = await store.set('llmApiKey', 'sk-abc');
    expect(result.location).toBe('keychain');
  });

  it('get reads back the keychain value', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    await store.set('llmApiKey', 'sk-roundtrip');
    expect(await store.get('llmApiKey')).toBe('sk-roundtrip');
  });

  it('remove clears the keychain entry', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    await store.set('llmApiKey', 'sk-bye');
    await store.remove('llmApiKey');
    expect(await store.get('llmApiKey')).toBeNull();
  });

  it('does NOT write a file when keychain succeeded', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    await store.set('llmApiKey', 'sk-keychain-only');
    expect(existsSync(join(tmp, 'keys', 'llmApiKey'))).toBe(false);
  });
});

describe('defaultSecretStore — file fallback', () => {
  let tmp: string;

  beforeEach(() => {
    _store.clear();
    _setAvailable(false); // simulate "no keychain available"
    _setThrowOnSet(false);
    tmp = mkdtempSync(join(tmpdir(), 'wigolo-ss-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('set returns location: file when keychain is unavailable', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    const result = await store.set('llmApiKey', 'sk-on-disk');
    expect(result.location).toBe('file');
  });

  it('writes the file with mode 0o600', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    await store.set('llmApiKey', 'sk-on-disk');
    const path = join(tmp, 'keys', 'llmApiKey');
    expect(existsSync(path)).toBe(true);
    const stat = statSync(path);
    // Mask off file-type bits, compare only permission bits.
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf-8')).toBe('sk-on-disk');
  });

  it('creates the keys dir with mode 0o700', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    await store.set('llmApiKey', 'sk-on-disk');
    const dir = join(tmp, 'keys');
    const stat = statSync(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('get reads the file value back', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    await store.set('llmApiKey', 'sk-round-file');
    expect(await store.get('llmApiKey')).toBe('sk-round-file');
  });

  it('remove deletes the file', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    await store.set('llmApiKey', 'sk-bye-file');
    await store.remove('llmApiKey');
    expect(existsSync(join(tmp, 'keys', 'llmApiKey'))).toBe(false);
    expect(await store.get('llmApiKey')).toBeNull();
  });

  it('get returns null for an absent key', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    expect(await store.get('llmApiKey')).toBeNull();
  });

  it('remove on an absent key is a silent no-op', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    await expect(store.remove('llmApiKey')).resolves.toBeUndefined();
  });
});

describe('defaultSecretStore — keychain-available-but-throws falls back to file', () => {
  let tmp: string;

  beforeEach(() => {
    _store.clear();
    _setAvailable(true);
    _setThrowOnSet(true); // keychainSet will throw
    tmp = mkdtempSync(join(tmpdir(), 'wigolo-ss-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns location: file when keychain.set throws despite availability probe', async () => {
    const store = defaultSecretStore({ dataDir: tmp });
    const result = await store.set('llmApiKey', 'sk-fallback');
    expect(result.location).toBe('file');
    expect(readFileSync(join(tmp, 'keys', 'llmApiKey'), 'utf-8')).toBe('sk-fallback');
  });
});
