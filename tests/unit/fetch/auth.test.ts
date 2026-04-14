import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/cdp-client.js', () => ({
  discoverSessions: vi.fn(),
  isCDPReachable: vi.fn(),
}));

import { getAuthOptions, listSessions } from '../../../src/fetch/auth.js';
import { discoverSessions, isCDPReachable } from '../../../src/fetch/cdp-client.js';
import type { CDPSession } from '../../../src/types.js';

describe('getAuthOptions()', () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_AUTH_STATE_PATH;
    delete process.env.WIGOLO_CHROME_PROFILE_PATH;
    delete process.env.WIGOLO_CDP_URL;
    resetConfig();
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'wigolo-auth-test-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when no auth configured', async () => {
    const result = await getAuthOptions();
    expect(result).toBeNull();
  });

  it('returns storageStatePath when WIGOLO_AUTH_STATE_PATH is set and file exists', async () => {
    const stateFile = join(tempDir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({ cookies: [] }));

    process.env.WIGOLO_AUTH_STATE_PATH = stateFile;
    resetConfig();

    const result = await getAuthOptions();
    expect(result).not.toBeNull();
    expect(result?.storageStatePath).toBe(stateFile);
    expect(result?.userDataDir).toBeUndefined();
  });

  it('throws when auth state file does not exist', async () => {
    const missingPath = join(tempDir, 'nonexistent.json');
    process.env.WIGOLO_AUTH_STATE_PATH = missingPath;
    resetConfig();

    await expect(getAuthOptions()).rejects.toThrow();
  });

  it('returns userDataDir as a temp copy when WIGOLO_CHROME_PROFILE_PATH is set', async () => {
    process.env.WIGOLO_CHROME_PROFILE_PATH = tempDir;
    resetConfig();

    const result = await getAuthOptions();
    expect(result).not.toBeNull();
    expect(result?.userDataDir).toBeDefined();
    expect(result?.userDataDir).not.toBe(tempDir);
    expect(result?.userDataDir).toContain('wigolo-chrome-');
    expect(result?.storageStatePath).toBeUndefined();
  });

  it('logs warning when Chrome lock file is present', async () => {
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
      await getAuthOptions();
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    const combined = warnings.join('');
    expect(combined).toMatch(/chrome.*running|running.*chrome|SingletonLock/i);
  });

  it('prefers authStatePath over chromeProfilePath when both are set', async () => {
    const stateFile = join(tempDir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({ cookies: [] }));

    process.env.WIGOLO_AUTH_STATE_PATH = stateFile;
    process.env.WIGOLO_CHROME_PROFILE_PATH = tempDir;
    resetConfig();

    const result = await getAuthOptions();
    expect(result?.storageStatePath).toBe(stateFile);
    expect(result?.userDataDir).toBeUndefined();
  });
});

describe('listSessions', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_CDP_URL;
    resetConfig();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('returns sessions from CDP client when cdpUrl is configured', async () => {
    process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
    resetConfig();

    vi.mocked(discoverSessions).mockResolvedValue([
      { id: '1', url: 'https://google.com', title: 'Google', webSocketDebuggerUrl: 'ws://localhost:9222/1' },
      { id: '2', url: 'https://github.com', title: 'GitHub', webSocketDebuggerUrl: 'ws://localhost:9222/2' },
    ]);

    const sessions = await listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].title).toBe('Google');
    expect(sessions[1].url).toBe('https://github.com');
  });

  it('returns empty array when cdpUrl is not configured', async () => {
    delete process.env.WIGOLO_CDP_URL;
    resetConfig();

    const sessions = await listSessions();
    expect(sessions).toEqual([]);
    expect(vi.mocked(discoverSessions)).not.toHaveBeenCalled();
  });

  it('returns empty array when CDP discovery fails', async () => {
    process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
    resetConfig();

    vi.mocked(discoverSessions).mockResolvedValue([]);

    const sessions = await listSessions();
    expect(sessions).toEqual([]);
  });

  it('handles CDP discovery throwing', async () => {
    process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
    resetConfig();

    vi.mocked(discoverSessions).mockRejectedValue(new Error('Connection refused'));

    const sessions = await listSessions();
    expect(sessions).toEqual([]);
  });

  it('returns a new array on each call', async () => {
    delete process.env.WIGOLO_CDP_URL;
    resetConfig();

    const s1 = await listSessions();
    const s2 = await listSessions();
    expect(s1).not.toBe(s2);
    expect(s1).toEqual(s2);
  });

  it('is async-compatible', async () => {
    delete process.env.WIGOLO_CDP_URL;
    resetConfig();

    const result = listSessions();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual([]);
  });

  it('handles concurrent calls', async () => {
    process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
    resetConfig();

    vi.mocked(discoverSessions).mockResolvedValue([
      { id: '1', url: 'https://a.com', title: 'A', webSocketDebuggerUrl: 'ws://x/1' },
    ]);

    const [s1, s2, s3] = await Promise.all([
      listSessions(),
      listSessions(),
      listSessions(),
    ]);
    expect(s1).toHaveLength(1);
    expect(s2).toHaveLength(1);
    expect(s3).toHaveLength(1);
  });
});

describe('getAuthOptions --- CDP fallback', () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_AUTH_STATE_PATH;
    delete process.env.WIGOLO_CHROME_PROFILE_PATH;
    delete process.env.WIGOLO_CDP_URL;
    resetConfig();
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'wigolo-auth-test-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('falls back to CDP when no storage state or profile configured but CDP is reachable', async () => {
    process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
    resetConfig();

    vi.mocked(isCDPReachable).mockResolvedValue(true);

    const result = await getAuthOptions();
    expect(result).not.toBeNull();
    expect(result?.cdpUrl).toBe('http://localhost:9222');
  });

  it('returns null when CDP is configured but not reachable', async () => {
    process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
    resetConfig();

    vi.mocked(isCDPReachable).mockResolvedValue(false);

    const result = await getAuthOptions();
    expect(result).toBeNull();
  });

  it('prefers storage state over CDP', async () => {
    const stateFile = join(tempDir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({ cookies: [] }));
    process.env.WIGOLO_AUTH_STATE_PATH = stateFile;
    process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
    resetConfig();

    const result = await getAuthOptions();
    expect(result?.storageStatePath).toBe(stateFile);
    expect(result?.cdpUrl).toBeUndefined();
    expect(vi.mocked(isCDPReachable)).not.toHaveBeenCalled();
  });

  it('prefers Chrome profile over CDP', async () => {
    process.env.WIGOLO_CHROME_PROFILE_PATH = tempDir;
    process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
    resetConfig();

    const result = await getAuthOptions();
    expect(result?.userDataDir).toBeDefined();
    expect(result?.cdpUrl).toBeUndefined();
    expect(vi.mocked(isCDPReachable)).not.toHaveBeenCalled();
  });

  it('returns null when no auth method is available', async () => {
    const result = await getAuthOptions();
    expect(result).toBeNull();
  });

  it('handles isCDPReachable throwing', async () => {
    process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
    resetConfig();

    vi.mocked(isCDPReachable).mockRejectedValue(new Error('Network error'));

    const result = await getAuthOptions();
    expect(result).toBeNull();
  });
});
