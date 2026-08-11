import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * S10-e, at the boundary rather than in the unit. `acquireBrowserDriver` is tested on its own,
 * but the promise this slice makes is about `installBrowser`: a user who needs a browser still
 * gets one, and a user whose machine cannot fetch one is told why instead of being handed a
 * stack trace from a failed module resolution.
 */

const acquireMock = vi.fn(async () => ({
  outcome: 'already_present' as 'already_present' | 'acquired' | 'failed',
  detail: 'browser engine driver already available',
  error: undefined as string | undefined,
}));
vi.mock('../../../src/fetch/driver-acquire.js', () => ({
  acquireBrowserDriver: () => acquireMock(),
}));

vi.mock('../../../src/cli/tui/run-command.js', () => ({ runCommand: vi.fn() }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: vi.fn(() => '/fake/playwright/chromium/chrome'), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(() => '/fake/playwright/firefox/firefox'), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(() => '/fake/playwright/webkit/webkit'), launch: vi.fn(okLaunch) },
  };
});

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/test-wigolo', searchBackend: null, searxngUrl: null })),
}));

import { runCommand } from '../../../src/cli/tui/run-command.js';
import { installBrowser } from '../../../src/cli/warmup.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };

describe('installBrowser acquires the driver before the binary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    acquireMock.mockResolvedValue({
      outcome: 'already_present',
      detail: 'browser engine driver already available',
      error: undefined,
    });
  });

  it('proceeds to the binary install when a driver is already there', async () => {
    const r = await installBrowser('chromium');
    expect(r.ok).toBe(true);
    expect(acquireMock).toHaveBeenCalled();
    const args = vi.mocked(runCommand).mock.calls[0][1];
    expect(args).toContain('install');
    expect(args).toContain('chromium');
  });

  it('refuses with the acquisition’s own reason when no driver can be obtained', async () => {
    acquireMock.mockResolvedValue({
      outcome: 'failed',
      detail: 'driver download failed',
      error: 'npm ERR! network ETIMEDOUT',
    });
    const r = await installBrowser('chromium');
    expect(r.ok).toBe(false);
    // The cause survives to the surface. A bare "browser failed to install" would send the
    // operator looking at the browser, not at the network that actually failed.
    expect(r.error).toContain('driver download failed');
    expect(r.error).toContain('ETIMEDOUT');
  });

  it('does not run the browser CLI at all when the driver is missing', async () => {
    // ⚠ THE SELF-SATISFACTION CHECK. Asserting only `ok === false` would pass even if the code
    // went on to resolve a CLI that cannot exist and failed one frame later for an unrelated
    // reason. The claim is that it stops HERE, so the absence of the spawn is the assertion.
    acquireMock.mockResolvedValue({
      outcome: 'failed',
      detail: 'could not run the package manager',
      error: 'spawn npm ENOENT',
    });
    await installBrowser('chromium');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('treats a freshly acquired driver as good as a pre-existing one', async () => {
    acquireMock.mockResolvedValue({
      outcome: 'acquired',
      detail: 'browser engine driver installed',
      error: undefined,
    });
    const r = await installBrowser('chromium');
    expect(r.ok).toBe(true);
  });
});
