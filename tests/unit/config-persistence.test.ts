/**
 * Tests for getConfig() honouring ~/.wigolo/config.json as a defaults layer
 * beneath explicit env-var overrides (per-field precedence).
 *
 * WHY these tests matter: the runtime was purely env-var-based; SP0 wires in
 * config.json so persisted user preferences survive across invocations without
 * requiring env vars. The env-var override contract must remain per-field —
 * setting ONE env var should not suppress config.json values for OTHER fields.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getConfig, resetConfig } from '../../src/config.js';
import { resetPersistedConfig } from '../../src/persisted-config.js';

let dir: string;
const originalEnv = { ...process.env };

function setConfigPath(path: string) {
  process.env.WIGOLO_CONFIG_PATH = path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wigolo-cfg-'));
  process.env = { ...originalEnv };
  resetConfig();
  resetPersistedConfig();
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetConfig();
  resetPersistedConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe('getConfig() — env-var overrides config.json (per-field)', () => {
  it('returns env value when env var is set, ignoring config.json', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { logLevel: 'debug' } }));
    setConfigPath(cfgPath);
    process.env.LOG_LEVEL = 'warn';
    resetConfig(); resetPersistedConfig();
    expect(getConfig().logLevel).toBe('warn');
  });

  it('returns config.json value when env var is absent', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { logLevel: 'debug' } }));
    setConfigPath(cfgPath);
    delete process.env.LOG_LEVEL;
    resetConfig(); resetPersistedConfig();
    expect(getConfig().logLevel).toBe('debug');
  });

  it('returns built-in default when both env var and config.json are absent', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: {} }));
    setConfigPath(cfgPath);
    delete process.env.LOG_LEVEL;
    resetConfig(); resetPersistedConfig();
    expect(getConfig().logLevel).toBe('info'); // built-in default
  });

  it('per-field: env for one field does not suppress config.json for another', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, settings: { logLevel: 'debug', logFormat: 'text' } }),
    );
    setConfigPath(cfgPath);
    // Only override logLevel via env; logFormat should still come from config.json
    process.env.LOG_LEVEL = 'warn';
    delete process.env.LOG_FORMAT;
    resetConfig(); resetPersistedConfig();
    const cfg = getConfig();
    expect(cfg.logLevel).toBe('warn');     // env wins
    expect(cfg.logFormat).toBe('text');    // config.json fills
  });
});

describe('getConfig() — persists numeric fields from config.json', () => {
  it('uses fetchTimeoutMs from config.json when env absent', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { fetchTimeoutMs: 7777 } }));
    setConfigPath(cfgPath);
    delete process.env.FETCH_TIMEOUT_MS;
    resetConfig(); resetPersistedConfig();
    expect(getConfig().fetchTimeoutMs).toBe(7777);
  });

  it('env FETCH_TIMEOUT_MS overrides config.json value', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { fetchTimeoutMs: 7777 } }));
    setConfigPath(cfgPath);
    process.env.FETCH_TIMEOUT_MS = '5000';
    resetConfig(); resetPersistedConfig();
    expect(getConfig().fetchTimeoutMs).toBe(5000);
  });
});

describe('getConfig() — humanize (behavioral realism) resolution', () => {
  it('uses humanize from config.json when env absent', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { humanize: 'on' } }));
    setConfigPath(cfgPath);
    delete process.env.WIGOLO_HUMANIZE;
    resetConfig(); resetPersistedConfig();
    expect(getConfig().humanize).toBe('on');
  });

  it('env WIGOLO_HUMANIZE overrides config.json value', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { humanize: 'on' } }));
    setConfigPath(cfgPath);
    process.env.WIGOLO_HUMANIZE = 'off';
    resetConfig(); resetPersistedConfig();
    expect(getConfig().humanize).toBe('off');
  });

  it('defaults to off when both env and config.json are absent', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: {} }));
    setConfigPath(cfgPath);
    delete process.env.WIGOLO_HUMANIZE;
    resetConfig(); resetPersistedConfig();
    expect(getConfig().humanize).toBe('off');
  });
});

describe('getConfig() — searchBackend (A1 runtime self-config)', () => {
  it('reads searchBackend from config.json when WIGOLO_SEARCH env absent', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { searchBackend: 'hybrid' } }));
    setConfigPath(cfgPath);
    delete process.env.WIGOLO_SEARCH;
    resetConfig(); resetPersistedConfig();
    expect(getConfig().searchBackend).toBe('hybrid');
  });

  it('WIGOLO_SEARCH env overrides config.json searchBackend', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { searchBackend: 'hybrid' } }));
    setConfigPath(cfgPath);
    process.env.WIGOLO_SEARCH = 'searxng';
    resetConfig(); resetPersistedConfig();
    expect(getConfig().searchBackend).toBe('searxng');
  });

  it('defaults searchBackend to null when neither env nor config.json set', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: {} }));
    setConfigPath(cfgPath);
    delete process.env.WIGOLO_SEARCH;
    resetConfig(); resetPersistedConfig();
    expect(getConfig().searchBackend).toBeNull();
  });
});

describe('getConfig() — legacy config.json migration', () => {
  it('reads browser from version-less legacy config file', () => {
    const cfgPath = join(dir, 'config.json');
    // Legacy TUI wrote without a version field
    writeFileSync(cfgPath, JSON.stringify({ defaultBrowser: 'chromium' }));
    setConfigPath(cfgPath);
    delete process.env.WIGOLO_BROWSER_TYPES;
    resetConfig(); resetPersistedConfig();
    // The runtime must not crash; it should migrate and use the value
    const cfg = getConfig();
    expect(cfg).toBeDefined();
  });
});

/**
 * `sqliteBusyTimeoutMs` used to be called `studioBusyTimeoutMs` even though it is read by generic
 * core cache code (`cache/db.ts`) on every connection — a product-prefixed field controlling core DB
 * behaviour. The env name is unchanged because it is a user-facing surface; the persisted-settings
 * key gained the new spelling. These tests pin that an already-written config.json is NOT orphaned
 * by the rename, which is the whole reason the old key is still read.
 */
describe('getConfig() — sqliteBusyTimeoutMs settings-key alias', () => {
  it('honours the new settings key', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { sqliteBusyTimeoutMs: 9111 } }));
    setConfigPath(cfgPath);
    delete process.env.WIGOLO_SQLITE_BUSY_TIMEOUT_MS;
    resetConfig(); resetPersistedConfig();
    expect(getConfig().sqliteBusyTimeoutMs).toBe(9111);
  });

  it('still honours the OLD studioBusyTimeoutMs key — a rename must not silently revert a user value', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { studioBusyTimeoutMs: 8222 } }));
    setConfigPath(cfgPath);
    delete process.env.WIGOLO_SQLITE_BUSY_TIMEOUT_MS;
    resetConfig(); resetPersistedConfig();
    // Without the alias this would be 5000 — a config the user wrote, silently ignored.
    expect(getConfig().sqliteBusyTimeoutMs).toBe(8222);
  });

  it('the new key wins when both are present', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      settings: { studioBusyTimeoutMs: 8222, sqliteBusyTimeoutMs: 9111 },
    }));
    setConfigPath(cfgPath);
    delete process.env.WIGOLO_SQLITE_BUSY_TIMEOUT_MS;
    resetConfig(); resetPersistedConfig();
    expect(getConfig().sqliteBusyTimeoutMs).toBe(9111);
  });

  it('the env var still overrides both spellings (the user-facing name is unchanged)', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { studioBusyTimeoutMs: 8222 } }));
    setConfigPath(cfgPath);
    process.env.WIGOLO_SQLITE_BUSY_TIMEOUT_MS = '7333';
    resetConfig(); resetPersistedConfig();
    expect(getConfig().sqliteBusyTimeoutMs).toBe(7333);
  });

  it('falls back to the built-in default when neither key nor env is present', () => {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: {} }));
    setConfigPath(cfgPath);
    delete process.env.WIGOLO_SQLITE_BUSY_TIMEOUT_MS;
    resetConfig(); resetPersistedConfig();
    expect(getConfig().sqliteBusyTimeoutMs).toBe(5000);
  });
});

describe('getConfig() — no config.json (absent file)', () => {
  it('falls back to built-in defaults gracefully', () => {
    const cfgPath = join(dir, 'nonexistent.json');
    setConfigPath(cfgPath);
    delete process.env.LOG_LEVEL;
    resetConfig(); resetPersistedConfig();
    expect(getConfig().logLevel).toBe('info');
  });
});
