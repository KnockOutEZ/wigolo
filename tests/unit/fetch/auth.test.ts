import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfig } from '../../../src/config.js';
import { getAuthOptions } from '../../../src/fetch/auth.js';

describe('getAuthOptions()', () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_AUTH_STATE_PATH;
    delete process.env.WIGOLO_CHROME_PROFILE_PATH;
    resetConfig();
    tempDir = mkdtempSync(join(tmpdir(), 'wigolo-auth-test-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when no auth configured', () => {
    const result = getAuthOptions();
    expect(result).toBeNull();
  });

  it('returns storageStatePath when WIGOLO_AUTH_STATE_PATH is set and file exists', () => {
    const stateFile = join(tempDir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({ cookies: [] }));

    process.env.WIGOLO_AUTH_STATE_PATH = stateFile;
    resetConfig();

    const result = getAuthOptions();
    expect(result).not.toBeNull();
    expect(result?.storageStatePath).toBe(stateFile);
    expect(result?.userDataDir).toBeUndefined();
  });

  it('throws when auth state file does not exist', () => {
    const missingPath = join(tempDir, 'nonexistent.json');
    process.env.WIGOLO_AUTH_STATE_PATH = missingPath;
    resetConfig();

    expect(() => getAuthOptions()).toThrow();
  });

  it('returns userDataDir when WIGOLO_CHROME_PROFILE_PATH is set', () => {
    process.env.WIGOLO_CHROME_PROFILE_PATH = tempDir;
    resetConfig();

    const result = getAuthOptions();
    expect(result).not.toBeNull();
    expect(result?.userDataDir).toBe(tempDir);
    expect(result?.storageStatePath).toBeUndefined();
  });

  it('logs warning when Chrome lock file is present', () => {
    const lockFile = join(tempDir, 'SingletonLock');
    writeFileSync(lockFile, '');

    process.env.WIGOLO_CHROME_PROFILE_PATH = tempDir;
    resetConfig();

    const warnings: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
      warnings.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalStderrWrite(chunk, ...(args as Parameters<typeof originalStderrWrite>).slice(1));
    };

    try {
      getAuthOptions();
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    const combined = warnings.join('');
    expect(combined).toMatch(/chrome.*running|running.*chrome|SingletonLock/i);
  });

  it('prefers authStatePath over chromeProfilePath when both are set', () => {
    const stateFile = join(tempDir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({ cookies: [] }));

    process.env.WIGOLO_AUTH_STATE_PATH = stateFile;
    process.env.WIGOLO_CHROME_PROFILE_PATH = tempDir;
    resetConfig();

    const result = getAuthOptions();
    expect(result?.storageStatePath).toBe(stateFile);
    expect(result?.userDataDir).toBeUndefined();
  });
});
