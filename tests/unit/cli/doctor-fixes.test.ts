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
// doctor probes browser health via a real headless launch (shared with
// warmup, GH #116). Mock playwright so the probe never launches a real browser
// — without this the probe would try to spawn Chromium and hit the test timeout.
vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: vi.fn(() => '/fake/playwright/chromium/chrome'), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(() => '/fake/playwright/firefox/firefox'), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(() => '/fake/playwright/webkit/webkit'), launch: vi.fn(okLaunch) },
  };
});
vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerank: vi.fn().mockResolvedValue([{ id: '0', score: 0.9 }]),
  })),
}));

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

