import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readPersistedConfig,
  writePersistedConfig,
  resetPersistedConfig,
  _setCredentialKeychainForTests,
} from '../../../src/persisted-config.js';
import { saveInitConfig, readInitConfig } from '../../../src/cli/tui/utils/config-writer.js';

let dir: string;
let store: Map<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wigolo-proxy-cred-'));
  resetPersistedConfig();
  store = new Map();
  _setCredentialKeychainForTests({
    available: () => true,
    set: (user, value) => {
      store.set(user, value);
    },
    get: (user) => store.get(user) ?? null,
    del: (user) => {
      store.delete(user);
    },
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetPersistedConfig();
  _setCredentialKeychainForTests(null);
});

describe('write path — proxy/solver/reader inline credentials', () => {
  it('strips inline user:pass from proxyUrl before persisting; keychain holds the cred', () => {
    const path = join(dir, 'config.json');
    writePersistedConfig(path, {
      settings: { proxyUrl: 'http://alice:s3cret@proxy.example.com:8080' },
    });

    const onDisk = readFileSync(path, 'utf-8');
    expect(onDisk).not.toContain('alice');
    expect(onDisk).not.toContain('s3cret');
    expect(onDisk).toContain('proxy.example.com:8080');

    // Keychain has the userinfo under the per-field key.
    expect(store.get('proxyUrl-cred')).toBe('alice:s3cret');
  });

  it('splits solverUrl and hostedReaderUrl credentials to distinct keychain keys', () => {
    const path = join(dir, 'config.json');
    writePersistedConfig(path, {
      settings: {
        solverUrl: 'http://s-user:s-pass@solver.local:8191',
        hostedReaderUrl: 'https://r-user:r-pass@reader.example.com',
      },
    });
    const onDisk = readFileSync(path, 'utf-8');
    expect(onDisk).not.toContain('s-pass');
    expect(onDisk).not.toContain('r-pass');
    expect(store.get('solverUrl-cred')).toBe('s-user:s-pass');
    expect(store.get('hostedReaderUrl-cred')).toBe('r-user:r-pass');
  });

  it('leaves a credential-free URL untouched and clears any stale keychain cred', () => {
    const path = join(dir, 'config.json');
    store.set('proxyUrl-cred', 'stale:cred');
    writePersistedConfig(path, {
      settings: { proxyUrl: 'http://proxy.example.com:8080/' },
    });
    const cfg = readPersistedConfig(path);
    expect(cfg.settings.proxyUrl).toBe('http://proxy.example.com:8080/');
    // A new credential-free write must not leave a stale credential behind.
    expect(store.get('proxyUrl-cred')).toBeUndefined();
  });

  it('when keychain is unavailable: does NOT persist creds to disk, keeps bare URL', () => {
    _setCredentialKeychainForTests({
      available: () => false,
      set: () => {
        throw new Error('should not be called when unavailable');
      },
      get: () => null,
      del: () => {},
    });
    const path = join(dir, 'config.json');
    writePersistedConfig(path, {
      settings: { proxyUrl: 'http://alice:s3cret@proxy.example.com:8080' },
    });
    const onDisk = readFileSync(path, 'utf-8');
    expect(onDisk).not.toContain('s3cret');
    expect(onDisk).toContain('proxy.example.com:8080');
  });
});

describe('read path — hand-edited config.json with inline credentials', () => {
  it('strips inline userinfo from a hand-placed proxyUrl (never used at runtime)', () => {
    const path = join(dir, 'config.json');
    // Simulate a user hand-editing config.json with an embedded credential.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        settings: { proxyUrl: 'http://hand:edited@proxy.example.com:8080' },
      }),
    );
    resetPersistedConfig();
    const cfg = readPersistedConfig(path);
    expect(cfg.settings.proxyUrl).toBe('http://proxy.example.com:8080/');
    expect(cfg.settings.proxyUrl).not.toContain('hand');
    expect(cfg.settings.proxyUrl).not.toContain('edited');
    // A hand-placed credential is NOT promoted into the keychain silently.
    expect(store.get('proxyUrl-cred')).toBeUndefined();
  });
});

describe('TUI wizard path (saveInitConfig) — proxy survives, cred to keychain', () => {
  it('a wizard-set proxy with inline creds survives (bare on disk, cred in keychain)', () => {
    // The wizard collects settings by settingsPath and persists via
    // saveInitConfig → writePersistedConfig. proxyUrl is NOT denylisted, so
    // the bare host must survive to config.json (the historical collision was
    // the denylist silently dropping it).
    saveInitConfig(dir, { proxyUrl: 'http://wiz:pass@proxy.wizard.local:3128', useProxy: true });
    const settings = readInitConfig(dir);
    expect(settings.proxyUrl).toBe('http://proxy.wizard.local:3128/');
    expect(settings.useProxy).toBe(true);
    expect(store.get('proxyUrl-cred')).toBe('wiz:pass');
  });

  it('a wizard-set credential-free proxy survives verbatim', () => {
    saveInitConfig(dir, { proxyUrl: 'http://proxy.wizard.local:3128/' });
    expect(readInitConfig(dir).proxyUrl).toBe('http://proxy.wizard.local:3128/');
  });
});
