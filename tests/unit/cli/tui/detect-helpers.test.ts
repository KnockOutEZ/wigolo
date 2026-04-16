import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(), statSync: vi.fn() };
});

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { binaryInPath, dirExists, fileExists, getHome } from '../../../../src/cli/tui/detect-helpers.js';

describe('binaryInPath', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the resolved path when `which` succeeds (POSIX)', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      vi.mocked(spawnSync).mockReturnValue({
        status: 0, stdout: '/usr/local/bin/claude\n', stderr: '',
      } as any);
      expect(binaryInPath('claude')).toBe('/usr/local/bin/claude');
      expect(spawnSync).toHaveBeenCalledWith('which', ['claude'], expect.any(Object));
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it('returns null when `which` exits non-zero', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as any);
      expect(binaryInPath('xyz')).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it('uses `where` on Windows', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      vi.mocked(spawnSync).mockReturnValue({
        status: 0, stdout: 'C:\\Program Files\\Claude\\claude.exe\r\n', stderr: '',
      } as any);
      expect(binaryInPath('claude')).toBe('C:\\Program Files\\Claude\\claude.exe');
      expect(spawnSync).toHaveBeenCalledWith('where', ['claude'], expect.any(Object));
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it('takes the first line when `where` returns multiple paths', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      vi.mocked(spawnSync).mockReturnValue({
        status: 0, stdout: 'C:\\one.exe\r\nC:\\two.exe\r\n', stderr: '',
      } as any);
      expect(binaryInPath('foo')).toBe('C:\\one.exe');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it('returns null when spawnSync errors', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null, stdout: '', stderr: '', error: new Error('ENOENT'),
    } as any);
    expect(binaryInPath('whatever')).toBeNull();
  });
});

describe('dirExists', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when path exists and is a directory', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);
    expect(dirExists('/some/dir')).toBe(true);
  });

  it('returns false when path exists but is a file', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as any);
    expect(dirExists('/some/file')).toBe(false);
  });

  it('returns false when path does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(dirExists('/missing')).toBe(false);
  });

  it('returns false when statSync throws (permission denied)', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockImplementation(() => { throw new Error('EACCES'); });
    expect(dirExists('/locked')).toBe(false);
  });
});

describe('fileExists', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when path exists and is a regular file', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isFile: () => true } as any);
    expect(fileExists('/etc/hosts')).toBe(true);
  });

  it('returns false when path is a directory', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isFile: () => false } as any);
    expect(fileExists('/etc')).toBe(false);
  });

  it('returns false when path does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(fileExists('/none')).toBe(false);
  });
});

describe('getHome', () => {
  it('returns a non-empty path', () => {
    expect(getHome().length).toBeGreaterThan(0);
  });
});
