import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetPersistedConfig } from '../../../../../src/persisted-config.js';
import { writeEnvSettings, readEnvSettings, CURATED_ENV_VARS } from '../../../../../src/cli/tui/actions/persist-settings.js';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-sp3-test-'));
  configPath = join(tmpDir, 'config.json');
  resetPersistedConfig();
});

function cleanup() {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('readEnvSettings — no config file', () => {
  it('returns defaults for all curated vars when config file absent', () => {
    const settings = readEnvSettings(configPath);
    for (const meta of CURATED_ENV_VARS) {
      expect(settings[meta.settingsKey]).toBe(meta.defaultValue);
    }
    cleanup();
  });
});

describe('writeEnvSettings + readEnvSettings round-trip', () => {
  it('persists WIGOLO_SEARCH and reads it back', () => {
    writeEnvSettings({ WIGOLO_SEARCH: 'hybrid' }, configPath);
    resetPersistedConfig();
    const settings = readEnvSettings(configPath);
    expect(settings['WIGOLO_SEARCH']).toBe('hybrid');
    cleanup();
  });

  it('persists WIGOLO_LOG_LEVEL and reads it back', () => {
    writeEnvSettings({ WIGOLO_LOG_LEVEL: 'debug' }, configPath);
    resetPersistedConfig();
    const settings = readEnvSettings(configPath);
    expect(settings['WIGOLO_LOG_LEVEL']).toBe('debug');
    cleanup();
  });

  it('merges with existing settings (does not wipe unrelated keys)', () => {
    writeEnvSettings({ WIGOLO_SEARCH: 'hybrid' }, configPath);
    resetPersistedConfig();
    writeEnvSettings({ WIGOLO_LOG_LEVEL: 'debug' }, configPath);
    resetPersistedConfig();
    const settings = readEnvSettings(configPath);
    expect(settings['WIGOLO_SEARCH']).toBe('hybrid');
    expect(settings['WIGOLO_LOG_LEVEL']).toBe('debug');
    cleanup();
  });

  it('ignores keys NOT in CURATED_ENV_VARS', () => {
    writeEnvSettings({ SOME_RANDOM_KEY: 'value', WIGOLO_SEARCH: 'core' }, configPath);
    resetPersistedConfig();
    const settings = readEnvSettings(configPath);
    // SOME_RANDOM_KEY should not appear in the settings returned by readEnvSettings
    // (readEnvSettings only returns curated keys)
    expect(Object.keys(settings)).not.toContain('SOME_RANDOM_KEY');
    expect(settings['WIGOLO_SEARCH']).toBe('core');
    cleanup();
  });

  it('a missing key returns defaultValue after partial write', () => {
    writeEnvSettings({ WIGOLO_SEARCH: 'searxng' }, configPath);
    resetPersistedConfig();
    const settings = readEnvSettings(configPath);
    const logMeta = CURATED_ENV_VARS.find((v) => v.envKey === 'WIGOLO_LOG_LEVEL')!;
    expect(settings[logMeta.settingsKey]).toBe(logMeta.defaultValue);
    cleanup();
  });
});

import { readPersistedConfig } from '../../../../../src/persisted-config.js';

describe('write safety: secrets never persisted', () => {
  it('does not persist braveApiKey even if caller includes it', () => {
    // braveApiKey is in SETTINGS_SECRETS_DENYLIST in persisted-config.ts
    // writeEnvSettings only writes curated keys, so this is doubly safe
    writeEnvSettings({ braveApiKey: 'supersecret', WIGOLO_SEARCH: 'core' } as Record<string, string>, configPath);
    resetPersistedConfig();
    const raw = readPersistedConfig(configPath);
    expect(raw.settings['braveApiKey']).toBeUndefined();
    cleanup();
  });
});
