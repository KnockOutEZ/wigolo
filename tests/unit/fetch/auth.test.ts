import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfig } from '../../../src/config.js';
import { getAuthOptions, listSessions } from '../../../src/fetch/auth.js';
import type { CDPSession } from '../../../src/types.js';

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

  it('returns userDataDir as a temp copy when WIGOLO_CHROME_PROFILE_PATH is set', () => {
    process.env.WIGOLO_CHROME_PROFILE_PATH = tempDir;
    resetConfig();

    const result = getAuthOptions();
    expect(result).not.toBeNull();
    expect(result?.userDataDir).toBeDefined();
    // Should be a temp directory, NOT the original
    expect(result?.userDataDir).not.toBe(tempDir);
    expect(result?.userDataDir).toContain('wigolo-chrome-');
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

describe('listSessions', () => {
  it('returns an empty array (v1 stub)', async () => {
    const sessions = await listSessions();
    expect(sessions).toEqual([]);
  });

  it('returns a typed array', async () => {
    const sessions = await listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('returns array with correct CDPSession shape (empty but typed)', async () => {
    const sessions: CDPSession[] = await listSessions();
    expect(sessions).toHaveLength(0);
  });

  it('returns a new array on each call (not shared reference)', async () => {
    const sessions1 = await listSessions();
    const sessions2 = await listSessions();
    expect(sessions1).not.toBe(sessions2);
    expect(sessions1).toEqual(sessions2);
  });

  it('resolves (is async-compatible)', async () => {
    const result = listSessions();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual([]);
  });

  it('handles concurrent calls without interference', async () => {
    const [s1, s2, s3] = await Promise.all([
      listSessions(),
      listSessions(),
      listSessions(),
    ]);
    expect(s1).toEqual([]);
    expect(s2).toEqual([]);
    expect(s3).toEqual([]);
    expect(s1).not.toBe(s2);
    expect(s2).not.toBe(s3);
  });

  it('result satisfies CDPSession[] type shape', async () => {
    const sessions = await listSessions();
    for (const session of sessions) {
      expect(session).toHaveProperty('id');
      expect(session).toHaveProperty('url');
      expect(session).toHaveProperty('title');
      expect(session).toHaveProperty('webSocketDebuggerUrl');
    }
    expect(sessions).toEqual([]);
  });

  it('does not throw under any conditions', async () => {
    await expect(listSessions()).resolves.not.toThrow();
  });
});
