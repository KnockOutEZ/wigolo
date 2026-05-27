import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We import via dynamic path manipulation so each test gets a fresh module.
// The module exposes a resetPersistedConfig() hook for tests.
import {
  readPersistedConfig,
  writePersistedConfig,
  resetPersistedConfig,
  PERSISTED_CONFIG_VERSION,
} from '../../src/persisted-config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wigolo-persisted-'));
  resetPersistedConfig();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetPersistedConfig();
});

// ---------------------------------------------------------------------------
// readPersistedConfig
// ---------------------------------------------------------------------------

describe('readPersistedConfig — no file', () => {
  it('returns current version with empty settings when file is absent', () => {
    const cfg = readPersistedConfig(join(dir, 'config.json'));
    expect(cfg.version).toBe(PERSISTED_CONFIG_VERSION);
    expect(cfg.settings).toEqual({});
  });
});

describe('readPersistedConfig — legacy (version-less) file', () => {
  it('migrates version-less file: preserves known keys, version becomes current', () => {
    const legacyPath = join(dir, 'config.json');
    writeFileSync(legacyPath, JSON.stringify({ defaultBrowser: 'chromium' }));
    const cfg = readPersistedConfig(legacyPath);
    expect(cfg.version).toBe(PERSISTED_CONFIG_VERSION);
    expect(cfg.settings.defaultBrowser).toBe('chromium');
  });
});

describe('readPersistedConfig — version > current (future/downgrade)', () => {
  it('reads file with future version without throwing, ignores unknown extras', () => {
    const futurePath = join(dir, 'config.json');
    writeFileSync(
      futurePath,
      JSON.stringify({
        version: PERSISTED_CONFIG_VERSION + 999,
        settings: { defaultBrowser: 'firefox', unknownFutureKey: 42 },
        provider: { name: 'openai', keyLocation: 'keychain' },
      }),
    );
    const cfg = readPersistedConfig(futurePath);
    // Must not throw; version is preserved verbatim (caller tolerates it).
    expect(cfg.version).toBeGreaterThan(PERSISTED_CONFIG_VERSION);
    expect(cfg.settings.defaultBrowser).toBe('firefox');
  });
});

describe('readPersistedConfig — current version file', () => {
  it('reads a well-formed v1 file correctly', () => {
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        settings: { defaultBrowser: 'chromium', searchBackend: 'core' },
      }),
    );
    const cfg = readPersistedConfig(path);
    expect(cfg.version).toBe(1);
    expect(cfg.settings.defaultBrowser).toBe('chromium');
    expect(cfg.settings.searchBackend).toBe('core');
  });

  it('preserves provider block when present', () => {
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        settings: {},
        provider: { name: 'anthropic', keyLocation: 'env' },
      }),
    );
    const cfg = readPersistedConfig(path);
    expect(cfg.provider?.name).toBe('anthropic');
    expect(cfg.provider?.keyLocation).toBe('env');
  });
});

// ---------------------------------------------------------------------------
// writePersistedConfig — atomic write
// ---------------------------------------------------------------------------

describe('writePersistedConfig', () => {
  it('creates the file with versioned envelope', () => {
    const path = join(dir, 'config.json');
    writePersistedConfig(path, { settings: { defaultBrowser: 'chromium' } });
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(raw.version).toBe(PERSISTED_CONFIG_VERSION);
    expect(raw.settings.defaultBrowser).toBe('chromium');
  });

  it('merge-patches settings — does not wipe keys not in patch', () => {
    const path = join(dir, 'config.json');
    writePersistedConfig(path, { settings: { defaultBrowser: 'chromium' } });
    writePersistedConfig(path, { settings: { searchBackend: 'core' } });
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(raw.settings.defaultBrowser).toBe('chromium');
    expect(raw.settings.searchBackend).toBe('core');
  });

  it('creates parent directory if absent', () => {
    const nested = join(dir, 'sub', 'config.json');
    writePersistedConfig(nested, { settings: { defaultBrowser: 'firefox' } });
    const raw = JSON.parse(readFileSync(nested, 'utf-8'));
    expect(raw.settings.defaultBrowser).toBe('firefox');
  });

  it('never persists a "key" field (secrets guard)', () => {
    const path = join(dir, 'config.json');
    // Caller attempts to write a secret field — must be stripped.
    writePersistedConfig(path, {
      settings: { defaultBrowser: 'chromium' },
      // @ts-expect-error intentional test of secret-stripping
      provider: { name: 'anthropic', keyLocation: 'env', key: 'sk-supersecret' },
    });
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(raw.provider?.key).toBeUndefined();
    expect(raw.provider?.name).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Caching behaviour
// ---------------------------------------------------------------------------

describe('readPersistedConfig — cache per-process', () => {
  it('returns the same object on second call (cache hit)', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ version: 1, settings: { defaultBrowser: 'chromium' } }));
    const a = readPersistedConfig(path);
    const b = readPersistedConfig(path);
    expect(a).toBe(b); // same reference
  });

  it('resetPersistedConfig clears the cache so next read re-reads disk', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ version: 1, settings: { defaultBrowser: 'chromium' } }));
    const first = readPersistedConfig(path);
    resetPersistedConfig();
    writeFileSync(path, JSON.stringify({ version: 1, settings: { defaultBrowser: 'firefox' } }));
    const second = readPersistedConfig(path);
    expect(first.settings.defaultBrowser).toBe('chromium');
    expect(second.settings.defaultBrowser).toBe('firefox');
  });
});
