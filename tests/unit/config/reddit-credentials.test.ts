import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, resetConfig, redditApiConfigured, DEFAULT_REDDIT_USER_AGENT } from '../../../src/config.js';
import {
  resetPersistedConfig,
  writePersistedConfig,
  readPersistedConfig,
  _setCredentialKeychainForTests,
} from '../../../src/persisted-config.js';

const originalEnv = process.env;
let dir: string;
let store: Map<string, string>;

beforeEach(() => {
  process.env = { ...originalEnv };
  dir = mkdtempSync(join(tmpdir(), 'wigolo-reddit-cred-'));
  process.env.WIGOLO_CONFIG_PATH = join(dir, 'config.json');
  delete process.env.WIGOLO_REDDIT_CLIENT_ID;
  delete process.env.WIGOLO_REDDIT_CLIENT_SECRET;
  delete process.env.WIGOLO_REDDIT_USER_AGENT;
  store = new Map();
  _setCredentialKeychainForTests({
    available: () => true,
    set: (u, v) => void store.set(u, v),
    get: (u) => store.get(u) ?? null,
    del: (u) => void store.delete(u),
  });
  resetPersistedConfig();
  resetConfig();
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(dir, { recursive: true, force: true });
  _setCredentialKeychainForTests(null);
  resetPersistedConfig();
  resetConfig();
});

describe('config — reddit credentials defaults', () => {
  it('client id / secret default to null; UA defaults; not configured', () => {
    const cfg = getConfig();
    expect(cfg.redditClientId).toBeNull();
    expect(cfg.redditClientSecret).toBeNull();
    expect(cfg.redditUserAgent).toBe(DEFAULT_REDDIT_USER_AGENT);
    expect(redditApiConfigured(cfg)).toBe(false);
  });

  it('reads client id + user agent from env; secret from env', () => {
    process.env.WIGOLO_REDDIT_CLIENT_ID = 'cid-123';
    process.env.WIGOLO_REDDIT_CLIENT_SECRET = 'env-secret';
    process.env.WIGOLO_REDDIT_USER_AGENT = 'web:custom:v2';
    resetConfig();
    const cfg = getConfig();
    expect(cfg.redditClientId).toBe('cid-123');
    expect(cfg.redditClientSecret).toBe('env-secret');
    expect(cfg.redditUserAgent).toBe('web:custom:v2');
    expect(redditApiConfigured(cfg)).toBe(true);
  });

  it('is NOT configured with only a client id (secret missing)', () => {
    process.env.WIGOLO_REDDIT_CLIENT_ID = 'cid-123';
    resetConfig();
    expect(redditApiConfigured(getConfig())).toBe(false);
  });
});

describe('config — reddit secret is keychain-backed, never cleartext on disk', () => {
  it('resolves the client secret from the keychain when not in env', () => {
    // Client id persisted to config.json (non-secret); secret only in keychain.
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { redditClientId: 'cid-persisted' } }),
    );
    store.set('redditClientSecret-cred', 'keychain-secret');
    resetPersistedConfig();
    resetConfig();
    const cfg = getConfig();
    expect(cfg.redditClientId).toBe('cid-persisted');
    expect(cfg.redditClientSecret).toBe('keychain-secret');
    expect(redditApiConfigured(cfg)).toBe(true);
  });

  it('strips the secret from a config.json write (denylist) — no cleartext on disk', () => {
    const path = join(dir, 'config.json');
    writePersistedConfig(path, {
      settings: { redditClientId: 'cid-1', redditClientSecret: 'should-not-persist', redditUserAgent: 'web:x:v1' },
    });
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as { settings: Record<string, unknown> };
    // Non-secret fields persisted; secret stripped.
    expect(onDisk.settings.redditClientId).toBe('cid-1');
    expect(onDisk.settings.redditUserAgent).toBe('web:x:v1');
    expect(onDisk.settings.redditClientSecret).toBeUndefined();
    // Raw file text never contains the secret.
    expect(readFileSync(path, 'utf-8')).not.toContain('should-not-persist');

    // The read path also never surfaces a secret from config.json (only env or
    // keychain feed redditClientSecret), so a hand-edited cleartext secret is
    // ignored at resolve time.
    writeFileSync(
      path,
      JSON.stringify({ version: 1, settings: { redditClientId: 'cid-1', redditClientSecret: 'hand-edited-cleartext' } }),
    );
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().redditClientSecret).toBeNull();
  });
});
