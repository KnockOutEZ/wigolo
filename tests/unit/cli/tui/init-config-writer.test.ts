import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveInitConfig, readInitConfig } from '../../../../src/cli/tui/utils/config-writer.js';

describe('saveInitConfig / readInitConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates config.json from scratch', () => {
    saveInitConfig(dir, { defaultBrowser: 'lightpanda' });
    const raw = readFileSync(join(dir, 'config.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ defaultBrowser: 'lightpanda' });
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
