import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveInitConfig, readInitConfig } from '../../../../src/cli/tui/utils/config-writer.js';
import { resetPersistedConfig } from '../../../../src/persisted-config.js';

describe('saveInitConfig / readInitConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-test-'));
    resetPersistedConfig();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetPersistedConfig();
  });

  it('creates config.json with versioned envelope', () => {
    saveInitConfig(dir, { defaultBrowser: 'chromium' });
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
    // File now uses the versioned schema (SP0); settings are under the settings key.
    expect(raw.version).toBe(1);
    expect(raw.settings.defaultBrowser).toBe('chromium');
  });

  it('merges into existing config', () => {
    saveInitConfig(dir, { defaultBrowser: 'chromium' });
    saveInitConfig(dir, { configuredAgents: ['claude-code'] });
    const config = readInitConfig(dir);
    expect(config).toEqual({
      defaultBrowser: 'chromium',
      configuredAgents: ['claude-code'],
    });
  });

  it('returns empty object for missing config', () => {
    expect(readInitConfig(dir)).toEqual({});
  });
});
