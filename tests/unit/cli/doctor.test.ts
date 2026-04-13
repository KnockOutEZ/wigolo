import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:child_process', () => ({ execSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { runDoctor } from '../../../src/cli/doctor.js';

function okProc(stdout = ''): ReturnType<typeof spawnSync> {
  return { status: 0, stdout, stderr: '', signal: null, pid: 1, output: [], error: undefined } as ReturnType<typeof spawnSync>;
}
function failProc(): ReturnType<typeof spawnSync> {
  return { status: 1, stdout: '', stderr: 'not found', signal: null, pid: 1, output: [], error: new Error('ENOENT') } as ReturnType<typeof spawnSync>;
}

describe('runDoctor', () => {
  let outBuffer = '';
  const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    outBuffer += String(chunk);
    return true;
  });

  beforeEach(() => { outBuffer = ''; resetConfig(); vi.clearAllMocks(); });
  afterEach(() => { resetConfig(); writeSpy.mockClear(); });

  it('exits 0 when everything is healthy', async () => {
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'python3' || cmd === 'docker') return okProc('Python 3.12.4');
      return okProc();
    });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
      return '';
    });
    const code = await runDoctor('/tmp/.wigolo');
    expect(code).toBe(0);
    expect(outBuffer).toMatch(/Overall: OK/i);
  });

  it('exits 1 when SearXNG state is failed', async () => {
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('state.json'));
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      status: 'failed',
      attempts: 2,
      lastAttemptAt: '2026-04-13T09:15:01Z',
      nextRetryAt: '2026-04-13T10:15:01Z',
      lastError: { message: 'pip install failed: 1', stderr: 'ERROR: ...', exitCode: 1, command: 'pip install', timestamp: '2026-04-13T09:15:01Z' },
    }));
    const code = await runDoctor('/tmp/.wigolo');
    expect(code).toBe(1);
    expect(outBuffer).toContain('attempts:      2');
    expect(outBuffer).toContain('pip install failed');
    expect(outBuffer).toContain('warmup --force');
    expect(outBuffer).toMatch(/Overall: DEGRADED/);
  });

  it('exits 0 when only optional packages missing', async () => {
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const joined = [cmd, ...((args ?? []) as string[])].join(' ');
      if (joined.includes('trafilatura') || joined.includes('flashrank')) return failProc();
      return okProc('Python 3.12.4');
    });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
      return '';
    });
    const code = await runDoctor('/tmp/.wigolo');
    expect(code).toBe(0);
  });

  it('exits 1 when Playwright is installed but chromium browser is missing', async () => {
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const joined = [cmd, ...((args ?? []) as string[])].join(' ');
      if (joined.includes('--version')) return okProc('1.50.0');
      if (joined.includes('--dry-run') && joined.includes('chromium'))
        return okProc('chromium is not installed');
      return okProc();
    });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
      return '';
    });
    const code = await runDoctor('/tmp/.wigolo');
    expect(code).toBe(1);
    expect(outBuffer).toContain('chromium missing');
  });

  it('exits 1 when no state file exists', async () => {
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockReturnValue(false);
    const code = await runDoctor('/tmp/.wigolo');
    expect(code).toBe(1);
    expect(outBuffer).toContain('not bootstrapped');
  });
});
