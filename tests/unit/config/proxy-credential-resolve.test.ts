import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, resetConfig } from '../../../src/config.js';
import {
  resetPersistedConfig,
  _setCredentialKeychainForTests,
} from '../../../src/persisted-config.js';

const originalEnv = process.env;
let dir: string;
let store: Map<string, string>;

beforeEach(() => {
  process.env = { ...originalEnv };
  dir = mkdtempSync(join(tmpdir(), 'wigolo-cred-resolve-'));
  process.env.WIGOLO_CONFIG_PATH = join(dir, 'config.json');
  delete process.env.PROXY_URL;
  delete process.env.WIGOLO_SOLVER_URL;
  delete process.env.WIGOLO_HOSTED_READER_URL;
  delete process.env.USE_PROXY;
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

describe('config — proxy/solver/reader defaults', () => {
  it('all default to null / off when unset', () => {
    const cfg = getConfig();
    expect(cfg.proxyUrl).toBeNull();
    expect(cfg.solverUrl).toBeNull();
    expect(cfg.hostedReaderUrl).toBeNull();
    expect(cfg.useProxy).toBe(false);
  });

  it('reads solverUrl / hostedReaderUrl from env', () => {
    process.env.WIGOLO_SOLVER_URL = 'http://127.0.0.1:8191/v1';
    process.env.WIGOLO_HOSTED_READER_URL = 'https://r.jina.ai';
    resetConfig();
    const cfg = getConfig();
    expect(cfg.solverUrl).toBe('http://127.0.0.1:8191/v1');
    expect(cfg.hostedReaderUrl).toBe('https://r.jina.ai');
  });
});

describe('config — credential recompose from keychain', () => {
  it('recomposes proxyUrl from config.json bare host + keychain userinfo', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { proxyUrl: 'http://proxy.example.com:8080/' } }),
    );
    store.set('proxyUrl-cred', 'alice:s3cret');
    resetPersistedConfig();
    resetConfig();
    const cfg = getConfig();
    expect(cfg.proxyUrl).toBe('http://alice:s3cret@proxy.example.com:8080/');
  });

  it('does NOT recompose when a value already carries userinfo (env, trusted)', () => {
    // An env-provided proxy is trusted/ephemeral and used verbatim; keychain is
    // not consulted to double-apply a credential.
    process.env.PROXY_URL = 'http://env-user:env-pass@proxy.example.com:8080';
    store.set('proxyUrl-cred', 'other:cred');
    resetConfig();
    const cfg = getConfig();
    expect(cfg.proxyUrl).toBe('http://env-user:env-pass@proxy.example.com:8080');
    expect(cfg.proxyUrl).not.toContain('other');
  });

  it('leaves a credential-free URL untouched when keychain has no cred', () => {
    process.env.PROXY_URL = 'http://proxy.example.com:8080/';
    resetConfig();
    expect(getConfig().proxyUrl).toBe('http://proxy.example.com:8080/');
  });
});
