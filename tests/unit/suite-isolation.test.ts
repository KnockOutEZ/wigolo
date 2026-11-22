import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigPath } from '../../src/persisted-config.js';

// The suite must never touch a developer's real ~/.wigolo (see tests/setup.ts).
describe('suite isolation', () => {
  it('resolves config.json outside the real home dir', () => {
    expect(defaultConfigPath()).not.toBe(join(homedir(), '.wigolo', 'config.json'));
    expect(process.env.WIGOLO_CONFIG_PATH).toContain('wigolo-test');
  });

  it('keeps the data dir outside the real home dir', () => {
    expect(process.env.WIGOLO_DATA_DIR).toContain('wigolo-test');
  });
});
