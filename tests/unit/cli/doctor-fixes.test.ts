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

let outBuffer = '';
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  outBuffer = '';
  resetConfig();
  vi.clearAllMocks();
  writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    outBuffer += String(chunk);
    return true;
  });
});

afterEach(() => {
  resetConfig();
  delete process.env.WIGOLO_DATA_DIR;
  writeSpy.mockRestore();
});

describe('doctor — SearXNG process state is not a hard failure', () => {
  it('returns 0 and says "starts on-demand" when installed but not running', async () => {
    vi.mocked(spawnSync).mockReturnValue(okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return true;
      if (s.endsWith('searxng.lock')) return false;
      return true;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('state.json')) {
        return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      }
      return '';
    });

    const code = await runDoctor('/tmp/.wigolo');

    expect(code).toBe(0);
    expect(outBuffer).toMatch(/not running.*starts on-demand/i);
    expect(outBuffer).toMatch(/Overall: OK/);
  });

  it('returns 0 when stale lock exists but SearXNG is installed', async () => {
    vi.mocked(spawnSync).mockReturnValue(okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: 99999999, port: 8888 });
      return '';
    });

    const code = await runDoctor('/tmp/.wigolo');

    expect(code).toBe(0);
    expect(outBuffer).toMatch(/Overall: OK/);
  });
});

describe('doctor — package detected even when __version__ missing', () => {
  beforeEach(() => {
    process.env.WIGOLO_DATA_DIR = '/tmp/wigolo';
  });

  it('reports flashrank as installed when import succeeds but __version__ probe fails', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ status: 'ready', searxngPath: '/tmp/wigolo/searxng' }),
    );
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const argList = (args ?? []) as string[];
      const script = argList.find((a) => a.includes('import')) ?? '';
      // version probe (has __version__) — fail like real FlashRank
      if (script.includes('__version__')) {
        return { status: 1, stdout: '', stderr: 'AttributeError', signal: null, pid: 1, output: [], error: undefined } as ReturnType<typeof spawnSync>;
      }
      // bare import succeeds
      return okProc('');
    });

    const code = await runDoctor('/tmp/wigolo');

    expect(outBuffer).toMatch(/ML reranker:\s+installed/);
    expect(code).toBe(0);
  });
});

describe('doctor — package import uses venv python', () => {
  beforeEach(() => {
    process.env.WIGOLO_DATA_DIR = '/tmp/wigolo';
  });

  it('invokes venv python for trafilatura import when venv exists', async () => {
    const venvPython = '/tmp/wigolo/searxng/venv/bin/python';
    vi.mocked(spawnSync).mockReturnValue(okProc('ok'));
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === venvPython) return true;
      if (s.endsWith('state.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ status: 'ready', searxngPath: '/tmp/wigolo/searxng' }),
    );

    await runDoctor('/tmp/wigolo');

    const calls = vi.mocked(spawnSync).mock.calls;
    const trafCall = calls.find((c) => {
      const args = (c[1] ?? []) as string[];
      return args.some((a) => a.includes('trafilatura'));
    });
    expect(trafCall).toBeDefined();
    expect(trafCall?.[0]).toBe(venvPython);
  });

  it('falls back to python3 for imports when venv missing', async () => {
    vi.mocked(spawnSync).mockReturnValue(okProc('ok'));
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ status: 'ready', searxngPath: '/tmp/wigolo/searxng' }),
    );

    await runDoctor('/tmp/wigolo');

    const calls = vi.mocked(spawnSync).mock.calls;
    const flashCall = calls.find((c) => {
      const args = (c[1] ?? []) as string[];
      return args.some((a) => a.includes('flashrank'));
    });
    expect(flashCall?.[0]).toBe('python3');
  });
});
