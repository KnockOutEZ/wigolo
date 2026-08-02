import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The Ink wizard delegate. Its invocation IS the Ink mount — asserting it is
// NOT called proves the binary took the headless fallback instead of crashing.
const runConfigMock = vi.hoisted(() => vi.fn());
const isPackagedMock = vi.hoisted(() => vi.fn<() => boolean>());

vi.mock('../../../src/cli/config.js', () => ({ runConfig: runConfigMock }));
vi.mock('../../../src/util/packaged.js', () => ({
  isPackagedBinary: isPackagedMock,
  BINARY_TUI_UNAVAILABLE_MESSAGE:
    'interactive wizard unavailable in the standalone binary — use the flag-driven ' +
    '`wigolo init` (works fully headless) or run via npm (`npx wigolo init --wizard`)',
}));

// Mock the plain-path dependencies so the fallback path returns cleanly.
vi.mock('../../../src/cli/tui/system-check.js', () => ({
  runSystemCheck: vi.fn().mockResolvedValue({
    node: { ok: true, version: '22.14.0' },
    python: { ok: true, binary: 'python3', version: '3.12.5' },
    docker: { ok: true, version: '29.4.0' },
    disk: { ok: true, freeMb: 50000 },
    hardFailure: false,
  }),
}));
vi.mock('../../../src/cli/tui/banner.js', () => ({
  renderBanner: vi.fn(() => 'BANNER\n'),
  printAddMcpBanner: vi.fn(),
}));
vi.mock('../../../src/cli/tui/version.js', () => ({ getPackageVersion: vi.fn(() => '0.6.3') }));
vi.mock('../../../src/cli/warmup.js', () => ({ runWarmup: vi.fn() }));
vi.mock('../../../src/cli/tui/agents.js', () => ({ detectAgents: vi.fn(() => []) }));
vi.mock('../../../src/cli/tui/select-agents.js', () => ({
  selectAgents: vi.fn().mockResolvedValue([]),
  NotTtyError: class NotTtyError extends Error {},
}));
vi.mock('../../../src/cli/tui/config-writer.js', () => ({ applyConfigs: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/cli/tui/verify.js', () => ({ runVerify: vi.fn().mockResolvedValue({ allPassed: true }) }));
vi.mock('../../../src/config.js', () => ({ getConfig: () => ({ dataDir: '/tmp/data' }) }));
vi.mock('../../../src/cli/tui/utils/config-writer.js', () => ({
  saveInitConfig: vi.fn(),
  readInitConfig: vi.fn(() => ({})),
}));
vi.mock('../../../src/cli/tui/actions/setup-status.js', () => ({
  probeSetupStatus: vi.fn().mockResolvedValue([]),
  defaultProbeDeps: () => ({}),
  summarizeSetup: vi.fn(() => ({ lines: [], readyCount: 6, total: 6, requiredFailed: false, exitCode: 0 })),
}));
vi.mock('../../../src/cli/tui/state/uninstall-signal.js', () => ({ wasUninstalled: vi.fn(() => false) }));
vi.mock('../../../src/cli/tui/reporter-auto.js', () => ({
  autoReporter: vi.fn(() => ({ start: vi.fn(), success: vi.fn(), fail: vi.fn(), note: vi.fn() })),
}));

import { runInit } from '../../../src/cli/init.js';

function capture(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (process.stdout.write as any) = (chunk: any) => { stdout.push(String(chunk)); return true; };
  (process.stderr.write as any) = (chunk: any) => { stderr.push(String(chunk)); return true; };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = origOut as any;
      process.stderr.write = origErr as any;
    },
  };
}

describe('init --wizard inside the standalone binary', () => {
  let prevTTY: boolean | undefined;
  let prevCI: string | undefined;
  let prevGha: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    runConfigMock.mockResolvedValue(0);
    prevTTY = process.stdout.isTTY;
    prevCI = process.env.CI;
    prevGha = process.env.GITHUB_ACTIONS;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
    if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
    if (prevGha === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prevGha;
  });

  it('does NOT mount the Ink wizard and prints the actionable headless fallback', async () => {
    isPackagedMock.mockReturnValue(true);
    const cap = capture();
    try {
      const code = await runInit(['--wizard']);
      expect(code).toBe(0);
      // The Ink mount delegate must never be reached inside the binary.
      expect(runConfigMock).not.toHaveBeenCalled();
      const err = cap.stderr.join('');
      expect(err).toMatch(/interactive wizard unavailable in the standalone binary/);
      expect(err).toMatch(/wigolo init/);
      expect(err).toMatch(/npx wigolo init --wizard/);
    } finally {
      cap.restore();
    }
  });

  it('on the npm/source path (not packaged), --wizard still mounts the Ink wizard', async () => {
    isPackagedMock.mockReturnValue(false);
    const cap = capture();
    try {
      await runInit(['--wizard']);
      expect(runConfigMock).toHaveBeenCalledTimes(1);
      expect(runConfigMock.mock.calls[0]?.[0]).toEqual(['--force-wizard']);
      expect(cap.stderr.join('')).not.toMatch(/unavailable in the standalone binary/);
    } finally {
      cap.restore();
    }
  });
});
