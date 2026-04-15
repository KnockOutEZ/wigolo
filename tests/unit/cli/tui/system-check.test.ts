import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    statfs: vi.fn(),
  };
});

import { spawnSync } from 'node:child_process';
import { statfs } from 'node:fs';
import {
  checkNode,
  checkPython,
  checkDocker,
  checkDiskSpace,
  runSystemCheck,
} from '../../../../src/cli/tui/system-check.js';

function mockSpawn(stdout: string, status = 0): void {
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    output: [null, stdout, ''],
    stdout,
    stderr: '',
    status,
    signal: null,
  } as any);
}

function mockStatfs(bavail: number, bsize = 4096): void {
  vi.mocked(statfs).mockImplementation(((_path: string, cb: any) => {
    cb(null, { bavail: BigInt(bavail), bsize: BigInt(bsize) } as any);
  }) as any);
}

describe('checkNode', () => {
  it('accepts Node 20 and above', () => {
    const originalVersion = process.version;
    Object.defineProperty(process, 'version', { value: 'v20.0.0', configurable: true });
    try {
      const r = checkNode();
      expect(r.ok).toBe(true);
      expect(r.version).toBe('20.0.0');
    } finally {
      Object.defineProperty(process, 'version', { value: originalVersion, configurable: true });
    }
  });

  it('accepts Node 22', () => {
    const originalVersion = process.version;
    Object.defineProperty(process, 'version', { value: 'v22.14.0', configurable: true });
    try {
      expect(checkNode().ok).toBe(true);
    } finally {
      Object.defineProperty(process, 'version', { value: originalVersion, configurable: true });
    }
  });

  it('rejects Node 18', () => {
    const originalVersion = process.version;
    Object.defineProperty(process, 'version', { value: 'v18.20.0', configurable: true });
    try {
      const r = checkNode();
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/requires Node 20/i);
    } finally {
      Object.defineProperty(process, 'version', { value: originalVersion, configurable: true });
    }
  });

  it('rejects unparseable version string', () => {
    const originalVersion = process.version;
    Object.defineProperty(process, 'version', { value: 'bogus', configurable: true });
    try {
      expect(checkNode().ok).toBe(false);
    } finally {
      Object.defineProperty(process, 'version', { value: originalVersion, configurable: true });
    }
  });
});

describe('checkPython', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects Python 3 via python3', () => {
    mockSpawn('Python 3.12.5\n');
    const r = checkPython();
    expect(r.ok).toBe(true);
    expect(r.version).toBe('3.12.5');
    expect(r.binary).toBe('python3');
  });

  it('falls back to python when python3 is missing', () => {
    vi.mocked(spawnSync).mockImplementation(((cmd: string) => {
      if (cmd === 'python3') {
        return { status: 127, stdout: '', stderr: '', error: new Error('not found') } as any;
      }
      return { status: 0, stdout: 'Python 3.11.0\n', stderr: '' } as any;
    }) as any);
    const r = checkPython();
    expect(r.ok).toBe(true);
    expect(r.binary).toBe('python');
    expect(r.version).toBe('3.11.0');
  });

  it('rejects Python 2.x even if found', () => {
    mockSpawn('Python 2.7.18\n');
    const r = checkPython();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Python 3/i);
  });

  it('handles completely missing python', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 127,
      stdout: '',
      stderr: '',
      error: new Error('ENOENT'),
    } as any);
    const r = checkPython();
    expect(r.ok).toBe(false);
    expect(r.version).toBeUndefined();
    expect(r.message).toMatch(/not found/i);
  });
});

describe('checkDocker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects docker when available', () => {
    mockSpawn('Docker version 29.4.0, build abcdef\n');
    const r = checkDocker();
    expect(r.ok).toBe(true);
    expect(r.version).toBe('29.4.0');
  });

  it('reports ok=false without message when docker missing (optional)', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 127,
      stdout: '',
      stderr: '',
      error: new Error('ENOENT'),
    } as any);
    const r = checkDocker();
    expect(r.ok).toBe(false);
    expect(r.version).toBeUndefined();
  });
});

describe('checkDiskSpace', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports ok when 500 MB or more available', async () => {
    mockStatfs(200_000, 4096);
    const r = await checkDiskSpace('/tmp');
    expect(r.ok).toBe(true);
    expect(r.freeMb).toBeGreaterThanOrEqual(500);
  });

  it('reports ok=false when less than 500 MB available', async () => {
    mockStatfs(50_000, 4096);
    const r = await checkDiskSpace('/tmp');
    expect(r.ok).toBe(false);
    expect(r.freeMb).toBeLessThan(500);
  });

  it('handles statfs errors gracefully', async () => {
    vi.mocked(statfs).mockImplementation(((_path: string, cb: any) => {
      cb(new Error('EPERM'));
    }) as any);
    const r = await checkDiskSpace('/tmp');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/EPERM|unable/i);
  });
});

describe('runSystemCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn('Python 3.12.5\n');
    mockStatfs(500_000, 4096);
  });

  it('returns a result object with all four checks', async () => {
    const r = await runSystemCheck();
    expect(r).toHaveProperty('node');
    expect(r).toHaveProperty('python');
    expect(r).toHaveProperty('docker');
    expect(r).toHaveProperty('disk');
  });

  it('sets hardFailure=true when Node is too old', async () => {
    const originalVersion = process.version;
    Object.defineProperty(process, 'version', { value: 'v16.0.0', configurable: true });
    try {
      const r = await runSystemCheck();
      expect(r.hardFailure).toBe(true);
    } finally {
      Object.defineProperty(process, 'version', { value: originalVersion, configurable: true });
    }
  });

  it('sets hardFailure=true when Python 3 is missing', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 127, stdout: '', stderr: '', error: new Error('ENOENT'),
    } as any);
    const r = await runSystemCheck();
    expect(r.hardFailure).toBe(true);
    expect(r.python.ok).toBe(false);
  });

  it('sets hardFailure=false when only Docker missing', async () => {
    vi.mocked(spawnSync).mockImplementation(((cmd: string) => {
      if (cmd === 'docker') {
        return { status: 127, stdout: '', stderr: '', error: new Error('ENOENT') } as any;
      }
      return { status: 0, stdout: 'Python 3.12.5\n', stderr: '' } as any;
    }) as any);
    const r = await runSystemCheck();
    expect(r.hardFailure).toBe(false);
    expect(r.docker.ok).toBe(false);
  });
});
