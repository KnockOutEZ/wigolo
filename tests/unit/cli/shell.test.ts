import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { resolveSearchBackend, getBootstrapState } from '../../../src/searxng/bootstrap.js';

vi.mock('../../../src/cache/db.js', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../../../src/fetch/browser-pool.js', () => ({
  BrowserPool: class {
    shutdown = vi.fn().mockResolvedValue(undefined);
    acquire = vi.fn();
    release = vi.fn();
  },
}));

vi.mock('../../../src/fetch/http-client.js', () => ({ httpFetch: vi.fn() }));

vi.mock('../../../src/fetch/router.js', () => ({
  SmartRouter: class {
    constructor(_h: unknown, _b: unknown) {}
    fetch = vi.fn();
    getDomainStats = vi.fn();
  },
}));

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  resolveSearchBackend: vi.fn().mockResolvedValue({ type: 'scraping' }),
  getBootstrapState: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/searxng/process.js', () => ({
  SearxngProcess: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
    getUrl: vi.fn().mockReturnValue(null),
  })),
}));

// startShell blocks on interactive stdin; short-circuit it so runShell returns.
// It now resolves to a ShellResult ({ failures }) that runShell destructures.
vi.mock('../../../src/repl/shell.js', () => ({
  startShell: vi.fn().mockResolvedValue({ failures: 0 }),
}));

describe('runShell — sidecar gate (D1)', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    vi.mocked(resolveSearchBackend).mockResolvedValue({ type: 'scraping' });
    vi.mocked(getBootstrapState).mockReturnValue(null);
  });
  afterEach(() => {
    delete process.env.WIGOLO_SEARCH;
    resetConfig();
  });

  it('performs ZERO sidecar activity on the default core backend', async () => {
    // WHY (D1): the interactive shell must not resolve/probe/spawn the sidecar
    // for a zero-config user.
    delete process.env.WIGOLO_SEARCH;
    resetConfig();
    const { runShell } = await import('../../../src/cli/shell.js');
    await runShell(['--json']);
    expect(resolveSearchBackend).not.toHaveBeenCalled();
  });

  it('DOES resolve the backend when WIGOLO_SEARCH=searxng and the sidecar is installed (positive control)', async () => {
    process.env.WIGOLO_SEARCH = 'searxng';
    resetConfig();
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });
    const { runShell } = await import('../../../src/cli/shell.js');
    await runShell(['--json']);
    expect(resolveSearchBackend).toHaveBeenCalled();
  });
});
