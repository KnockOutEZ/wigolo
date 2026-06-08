import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  };
});

const chromiumLaunch = vi.fn();
const chromiumExec = vi.fn(() => '/fake/playwright/chromium/chrome');
vi.mock('playwright', () => ({
  chromium: {
    executablePath: () => chromiumExec(),
    launch: (...args: unknown[]) => chromiumLaunch(...args),
  },
  firefox: {
    executablePath: () => '/fake/playwright/firefox/firefox',
    launch: vi.fn(),
  },
  webkit: {
    executablePath: () => '/fake/playwright/webkit/webkit',
    launch: vi.fn(),
  },
}));

import { existsSync } from 'node:fs';
import { probeBrowser } from '../../../src/fetch/browser-probe.js';

const fakeBrowser = { close: vi.fn().mockResolvedValue(undefined) };

describe('probeBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    chromiumExec.mockReturnValue('/fake/playwright/chromium/chrome');
    chromiumLaunch.mockResolvedValue(fakeBrowser);
  });

  it('reports launchable=true when the binary is on disk and launch succeeds', async () => {
    const r = await probeBrowser('chromium');

    expect(r.onDisk).toBe(true);
    expect(r.launchable).toBe(true);
    expect(r.execPath).toBe('/fake/playwright/chromium/chrome');
    expect(r.error).toBeUndefined();
    // Real smoke-test: launched headless, then closed.
    expect(chromiumLaunch).toHaveBeenCalledWith({ headless: true });
    expect(fakeBrowser.close).toHaveBeenCalled();
  });

  it('reports onDisk=false and never launches when the binary is missing', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const r = await probeBrowser('chromium');

    expect(r.onDisk).toBe(false);
    expect(r.launchable).toBe(false);
    expect(r.error).toContain('missing on disk');
    expect(chromiumLaunch).not.toHaveBeenCalled();
  });

  it('reports launchable=false when the binary is present but launch throws', async () => {
    // WHY: on bare Linux the binary lands on disk but launch fails because OS
    // shared libs (libnss3/libgbm) are missing. existsSync alone would lie.
    chromiumLaunch.mockRejectedValue(new Error('libnss3.so: cannot open shared object file'));

    const r = await probeBrowser('chromium');

    expect(r.onDisk).toBe(true);
    expect(r.launchable).toBe(false);
    expect(r.error).toContain('libnss3');
  });

  it('reports onDisk=false when executablePath() throws', async () => {
    chromiumExec.mockImplementation(() => {
      throw new Error('no executable');
    });

    const r = await probeBrowser('chromium');

    expect(r.onDisk).toBe(false);
    expect(r.launchable).toBe(false);
    expect(r.execPath).toBe('');
    expect(r.error).toContain('no executable');
  });

  it('treats a launch that never resolves as a failure (timeout)', async () => {
    chromiumLaunch.mockReturnValue(new Promise(() => {}));

    const r = await probeBrowser('chromium', { launchTimeoutMs: 20 });

    expect(r.onDisk).toBe(true);
    expect(r.launchable).toBe(false);
    expect(r.error).toContain('timed out');
  });

  it('still reports launchable=true even if close() throws', async () => {
    chromiumLaunch.mockResolvedValue({ close: vi.fn().mockRejectedValue(new Error('close fail')) });

    const r = await probeBrowser('chromium');

    expect(r.launchable).toBe(true);
    expect(r.error).toBeUndefined();
  });
});
