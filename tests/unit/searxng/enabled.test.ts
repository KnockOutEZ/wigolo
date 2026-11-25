import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The disk read for the ready-state check is isolated behind getBootstrapState.
// Mock it so searxngBackendAvailable can be exercised without touching the fs.
vi.mock('../../../src/searxng/bootstrap.js', () => ({
  getBootstrapState: vi.fn(),
  checkDockerAvailable: vi.fn(() => false),
}));

import { searxngConfigured, searxngBackendAvailable } from '../../../src/searxng/enabled.js';
import { getBootstrapState, checkDockerAvailable } from '../../../src/searxng/bootstrap.js';

type Cfg = { searchBackend: string | null; searxngUrl: string | null; dataDir: string; searxngMode?: 'native' | 'docker' };

function cfg(overrides: Partial<Cfg> = {}): Cfg {
  return {
    searchBackend: null,
    searxngUrl: null,
    dataDir: '/tmp/wigolo-test',
    ...overrides,
  };
}

describe('searxngConfigured', () => {
  it('is FALSE on the default core backend with no external URL (zero-config path)', () => {
    // WHY: the whole point of D1 — a keyless core-backend user must never trip
    // any searxng activity. If this returns true, the four call sites would
    // start probing/installing the sidecar on the default run.
    expect(searxngConfigured(cfg())).toBe(false);
    expect(searxngConfigured(cfg({ searchBackend: 'core' }))).toBe(false);
  });

  it('is TRUE when the backend is explicitly searxng', () => {
    expect(searxngConfigured(cfg({ searchBackend: 'searxng' }))).toBe(true);
  });

  it('is TRUE when the backend is hybrid', () => {
    // WHY: hybrid's fallback tier IS searxng, so opting into hybrid opts into
    // the sidecar.
    expect(searxngConfigured(cfg({ searchBackend: 'hybrid' }))).toBe(true);
  });

  it('is TRUE when an external searxngUrl is set regardless of backend', () => {
    // WHY: pointing at an external instance is an explicit opt-in even on core.
    expect(
      searxngConfigured(cfg({ searchBackend: 'core', searxngUrl: 'http://sx.local:8888' })),
    ).toBe(true);
    expect(searxngConfigured(cfg({ searxngUrl: 'http://sx.local:8888' }))).toBe(true);
  });
});

describe('searxngBackendAvailable', () => {
  beforeEach(() => {
    vi.mocked(getBootstrapState).mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is TRUE when an external URL is set (no disk probe needed)', () => {
    expect(searxngBackendAvailable(cfg({ searxngUrl: 'http://sx.local:8888' }))).toBe(true);
    // An external URL means we never consult on-disk state.
    expect(getBootstrapState).not.toHaveBeenCalled();
  });

  it('is TRUE when on-disk state reports a ready, installed sidecar', () => {
    // WHY: the user opted in earlier via `wigolo warmup --searxng`; the process
    // is installed and should be started, not re-installed.
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/sx' });
    expect(searxngBackendAvailable(cfg())).toBe(true);
  });

  it('is FALSE when no URL and no ready state (opted in but never installed)', () => {
    // WHY: hybrid/searxng backend selected but the sidecar was never bootstrapped.
    // The caller must NOT install implicitly — this predicate lets it emit an
    // actionable message instead.
    vi.mocked(getBootstrapState).mockReturnValue(null);
    expect(searxngBackendAvailable(cfg({ searchBackend: 'hybrid' }))).toBe(false);
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'failed' });
    expect(searxngBackendAvailable(cfg({ searchBackend: 'searxng' }))).toBe(false);
  });

  // #685: `warmup --searxng` in docker mode reports "started on demand", but the
  // server treated docker mode as "not installed" and never started it — on
  // Windows (no native sidecar) docker is the only way to run one.
  it('WHY: is TRUE in docker mode when a container CLI is on PATH (started on demand)', () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkDockerAvailable).mockReturnValue(true);
    expect(searxngBackendAvailable(cfg({ searchBackend: 'searxng', searxngMode: 'docker' }))).toBe(true);
  });

  it('is FALSE in docker mode when no container CLI is found', () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkDockerAvailable).mockReturnValue(false);
    expect(searxngBackendAvailable(cfg({ searchBackend: 'searxng', searxngMode: 'docker' }))).toBe(false);
  });

  it('native mode still needs a ready install even when a container CLI exists', () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkDockerAvailable).mockReturnValue(true);
    expect(searxngBackendAvailable(cfg({ searchBackend: 'searxng', searxngMode: 'native' }))).toBe(false);
    expect(searxngBackendAvailable(cfg({ searchBackend: 'searxng' }))).toBe(false);
  });
});
