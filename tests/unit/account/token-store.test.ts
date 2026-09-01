/**
 * Credential custody — the round trip must hold on BOTH tiers.
 *
 * The file arm is FORCED, not hoped for: `keychainAvailable` is driven to
 * `false` and the arm then asserts that `<dataDir>/keys/account.enc` actually
 * exists on disk and that the ciphertext does not contain the plaintext. An
 * arm that merely ran on a machine without a keyring would prove nothing on a
 * machine with one.
 *
 * The parallel-store property (A-212-3) is asserted too: the account
 * credential must not be reachable through the LLM key-store's surfaces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/security/keychain.js', () => {
  const store = new Map<string, string>();
  return {
    WIGOLO_SERVICE: 'wigolo',
    keychainAvailable: vi.fn(() => true),
    keychainSet: vi.fn((service: string, user: string, value: string) => { store.set(`${service}:${user}`, value); }),
    keychainGet: vi.fn((service: string, user: string) => store.get(`${service}:${user}`) ?? null),
    keychainDelete: vi.fn((service: string, user: string) => { store.delete(`${service}:${user}`); }),
    _store: store,
  };
});

const keychainMod = await import('../../../src/security/keychain.js');
const { keychainAvailable, keychainSet, _store } = keychainMod as typeof keychainMod & {
  _store: Map<string, string>;
};

const {
  storeRefreshToken,
  readRefreshToken,
  deleteRefreshToken,
  accountEncFilePath,
  setAccessToken,
  getAccessToken,
  clearAccessToken,
  _resetAccessTokenCache,
} = await import('../../../src/account/token-store.js');

const { ACCOUNT_KEYCHAIN_SERVICE, ACCOUNT_KEYCHAIN_USER } = await import('../../../src/account/constants.js');

const TOKEN = 'refresh-9f3c1a-secret';

let dataDir: string;

beforeEach(() => {
  _store.clear();
  _resetAccessTokenCache();
  vi.mocked(keychainAvailable).mockReturnValue(true);
  vi.mocked(keychainSet).mockImplementation((service: string, user: string, value: string) => {
    _store.set(`${service}:${user}`, value);
  });
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-acct-tok-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('refresh-token custody — keychain tier', () => {
  it('round-trips through the keychain under service wigolo-account', async () => {
    const stored = await storeRefreshToken(TOKEN, { dataDir });
    expect(stored.location).toBe('keychain');

    const read = await readRefreshToken({ dataDir });
    expect(read).toEqual({ value: TOKEN, location: 'keychain' });
    expect(_store.get(`${ACCOUNT_KEYCHAIN_SERVICE}:${ACCOUNT_KEYCHAIN_USER}`)).toBe(TOKEN);
    expect(ACCOUNT_KEYCHAIN_SERVICE).toBe('wigolo-account');
  });

  it('writes nothing to disk when the keychain accepted the credential', async () => {
    await storeRefreshToken(TOKEN, { dataDir });
    expect(existsSync(accountEncFilePath(dataDir))).toBe(false);
  });

  it('drops a stale file-tier copy when a later write lands in the keychain', async () => {
    // A machine that fell back once and then gained a working keyring would
    // otherwise keep an OLD, already-rotated credential readable on disk.
    vi.mocked(keychainAvailable).mockReturnValue(false);
    await storeRefreshToken('old-token', { dataDir });
    expect(existsSync(accountEncFilePath(dataDir))).toBe(true);

    vi.mocked(keychainAvailable).mockReturnValue(true);
    await storeRefreshToken('new-token', { dataDir });
    expect(existsSync(accountEncFilePath(dataDir))).toBe(false);
    expect((await readRefreshToken({ dataDir }))!.value).toBe('new-token');
  });

  it('falls back to the file when a keychain write throws despite the probe', async () => {
    // `keychainAvailable()` only constructs an Entry; a sandboxed or locked
    // keychain reports available and then throws on write. Losing the
    // credential to that gap would force a re-login with no way to detect it.
    vi.mocked(keychainSet).mockImplementation(() => { throw new Error('SecKeychain: user interaction not allowed'); });
    const stored = await storeRefreshToken(TOKEN, { dataDir });
    expect(stored.location).toBe('file');
    expect((await readRefreshToken({ dataDir }))).toEqual({ value: TOKEN, location: 'file' });
  });
});

describe('refresh-token custody — forced file-fallback tier', () => {
  beforeEach(() => {
    vi.mocked(keychainAvailable).mockReturnValue(false);
  });

  it('round-trips through <dataDir>/keys/account.enc', async () => {
    const stored = await storeRefreshToken(TOKEN, { dataDir });
    expect(stored.location).toBe('file');

    const path = accountEncFilePath(dataDir);
    expect(path).toBe(join(dataDir, 'keys', 'account.enc'));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const read = await readRefreshToken({ dataDir });
    expect(read).toEqual({ value: TOKEN, location: 'file' });
  });

  it('stores ciphertext — the token is not recoverable from the file bytes', async () => {
    await storeRefreshToken(TOKEN, { dataDir });
    const blob = readFileSync(accountEncFilePath(dataDir), 'utf8');
    expect(blob).not.toContain(TOKEN);
    expect(blob).not.toContain('refresh-9f3c1a');
  });

  it('reads as a miss when the file is corrupt rather than returning garbage', async () => {
    await storeRefreshToken(TOKEN, { dataDir });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(accountEncFilePath(dataDir), 'not-a-valid-blob', 'utf8');
    expect(await readRefreshToken({ dataDir })).toBeNull();
  });

  it('is keyed to the data dir — a relocated dir cannot decrypt the old file', async () => {
    await storeRefreshToken(TOKEN, { dataDir });
    const other = mkdtempSync(join(tmpdir(), 'wigolo-acct-tok-other-'));
    try {
      const { cpSync } = await import('node:fs');
      cpSync(join(dataDir, 'keys'), join(other, 'keys'), { recursive: true });
      expect(await readRefreshToken({ dataDir: other })).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('deleteRefreshToken', () => {
  it('clears both tiers, not just the one that answered', async () => {
    // Logout must not leave a copy behind on either tier.
    vi.mocked(keychainAvailable).mockReturnValue(false);
    await storeRefreshToken('file-copy', { dataDir });
    vi.mocked(keychainAvailable).mockReturnValue(true);
    _store.set(`${ACCOUNT_KEYCHAIN_SERVICE}:${ACCOUNT_KEYCHAIN_USER}`, 'keychain-copy');

    await deleteRefreshToken({ dataDir });

    expect(_store.size).toBe(0);
    expect(existsSync(accountEncFilePath(dataDir))).toBe(false);
    expect(await readRefreshToken({ dataDir })).toBeNull();
  });
});

describe('parallel store (A-212-3)', () => {
  it('the account credential is invisible to the LLM key-store surfaces', async () => {
    const { listProviders, PICKER_PROVIDERS } = await import('../../../src/security/key-store.js');
    await storeRefreshToken(TOKEN, { dataDir });

    const listed = await listProviders({ dataDir });
    expect(listed.map((p) => String(p.provider))).not.toContain('account');
    expect(PICKER_PROVIDERS.map(String)).not.toContain('account');
    // …and its keychain service is not one the key-store would ever construct.
    expect(ACCOUNT_KEYCHAIN_SERVICE).not.toBe('wigolo');
  });
});

describe('access JWT — memory only', () => {
  it('round-trips in memory and never touches the data dir', async () => {
    setAccessToken('access.jwt', 900, { dataDir }, 1_000_000);
    expect(getAccessToken({ dataDir }, 1_000_000)).toBe('access.jwt');
    expect(existsSync(join(dataDir, 'keys'))).toBe(false);
    expect(existsSync(join(dataDir, 'account'))).toBe(false);
  });

  it('expires the token 30s early so an in-flight call cannot 401 on the skew', () => {
    const t0 = 1_000_000;
    setAccessToken('access.jwt', 900, { dataDir }, t0);
    // 869s in: still 31s of headroom.
    expect(getAccessToken({ dataDir }, t0 + 869_000)).toBe('access.jwt');
    // 871s in: inside the 30s skew, treated as gone.
    expect(getAccessToken({ dataDir }, t0 + 871_000)).toBeNull();
  });

  it('is scoped per data dir', () => {
    setAccessToken('token-a', 900, { dataDir }, 1_000_000);
    expect(getAccessToken({ dataDir: '/some/other/dir' }, 1_000_000)).toBeNull();
  });

  it('clearAccessToken drops it', () => {
    setAccessToken('access.jwt', 900, { dataDir }, 1_000_000);
    clearAccessToken({ dataDir });
    expect(getAccessToken({ dataDir }, 1_000_000)).toBeNull();
  });
});
