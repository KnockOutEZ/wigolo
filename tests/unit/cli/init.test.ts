import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  runSystemCheckMock,
  renderBannerMock,
  getPackageVersionMock,
  runWarmupMock,
  detectAgentsMock,
  selectAgentsMock,
  applyConfigsMock,
  runVerifyMock,
  probeSetupStatusMock,
  summarizeSetupMock,
  runConfigMock,
  wasUninstalledMock,
} = vi.hoisted(() => ({
  runSystemCheckMock: vi.fn(),
  renderBannerMock: vi.fn(() => 'BANNER\n'),
  getPackageVersionMock: vi.fn(() => '0.6.3'),
  runWarmupMock: vi.fn(),
  detectAgentsMock: vi.fn(),
  selectAgentsMock: vi.fn(),
  applyConfigsMock: vi.fn(),
  runVerifyMock: vi.fn(),
  probeSetupStatusMock: vi.fn(),
  summarizeSetupMock: vi.fn(),
  runConfigMock: vi.fn(),
  wasUninstalledMock: vi.fn(() => false),
}));

vi.mock('../../../src/cli/tui/system-check.js', () => ({
  runSystemCheck: runSystemCheckMock,
}));
vi.mock('../../../src/cli/tui/banner.js', () => ({
  renderBanner: renderBannerMock,
  printAddMcpBanner: vi.fn(),
}));
vi.mock('../../../src/cli/tui/version.js', () => ({
  getPackageVersion: getPackageVersionMock,
}));
vi.mock('../../../src/cli/warmup.js', () => ({
  runWarmup: runWarmupMock,
}));
vi.mock('../../../src/cli/tui/agents.js', () => ({
  detectAgents: detectAgentsMock,
}));
vi.mock('../../../src/cli/tui/select-agents.js', () => ({
  selectAgents: selectAgentsMock,
  NotTtyError: class NotTtyError extends Error {
    constructor(msg?: string) { super(msg ?? 'not a TTY'); this.name = 'NotTtyError'; }
  },
}));
vi.mock('../../../src/cli/tui/config-writer.js', () => ({
  applyConfigs: applyConfigsMock,
}));
vi.mock('../../../src/cli/tui/verify.js', () => ({
  runVerify: runVerifyMock,
}));
vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/data' }),
}));
vi.mock('../../../src/cli/tui/utils/config-writer.js', () => ({
  saveInitConfig: vi.fn(),
  readInitConfig: vi.fn(() => ({})),
}));
vi.mock('../../../src/cli/tui/actions/setup-status.js', () => ({
  probeSetupStatus: probeSetupStatusMock,
  defaultProbeDeps: () => ({}),
  summarizeSetup: summarizeSetupMock,
}));
vi.mock('../../../src/cli/config.js', () => ({
  runConfig: runConfigMock,
}));
vi.mock('../../../src/cli/tui/state/uninstall-signal.js', () => ({
  wasUninstalled: wasUninstalledMock,
}));
vi.mock('../../../src/cli/tui/reporter-auto.js', () => ({
  autoReporter: vi.fn(() => ({
    start: vi.fn(),
    success: vi.fn(),
    fail: vi.fn(),
    note: vi.fn(),
  })),
}));

import { runInit } from '../../../src/cli/init.js';

function capture(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as any) = (chunk: any) => { stdout.push(String(chunk)); return true; };
  (process.stderr.write as any) = (chunk: any) => { stderr.push(String(chunk)); return true; };
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = origOut as any;
      process.stderr.write = origErr as any;
    },
  };
}

function primeHappyPath(): void {
  runSystemCheckMock.mockResolvedValue({
    node: { ok: true, version: '22.14.0' },
    python: { ok: true, binary: 'python3', version: '3.12.5' },
    docker: { ok: true, version: '29.4.0' },
    disk: { ok: true, freeMb: 50000 },
    hardFailure: false,
  });
  runWarmupMock.mockResolvedValue(undefined);
  detectAgentsMock.mockReturnValue([
    { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file', configPath: '/h/.cursor/mcp.json' },
  ]);
  selectAgentsMock.mockResolvedValue([]);
  applyConfigsMock.mockResolvedValue([]);
  runVerifyMock.mockResolvedValue({ allPassed: true });
  probeSetupStatusMock.mockResolvedValue([]);
  summarizeSetupMock.mockReturnValue({
    lines: ['Setup: 6/6 ready'],
    readyCount: 6,
    total: 6,
    requiredFailed: false,
    exitCode: 0,
  });
}

describe('runInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderBannerMock.mockReturnValue('BANNER\n');
    getPackageVersionMock.mockReturnValue('0.6.3');
    probeSetupStatusMock.mockResolvedValue([]);
    summarizeSetupMock.mockReturnValue({
      lines: ['Setup: 6/6 ready'],
      readyCount: 6,
      total: 6,
      requiredFailed: false,
      exitCode: 0,
    });
  });

  it('exits 0 on all-ok system (non-interactive path)', async () => {
    primeHappyPath();
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toContain('BANNER');
      expect(out).toContain('Node');
      expect(out).toContain('22.14.0');
      expect(out).toContain('Python');
      expect(out).toContain('3.12.5');
      expect(out).toContain('Docker');
    } finally {
      cap.restore();
    }
  });

  it('exits 1 when Node is too old', async () => {
    runSystemCheckMock.mockResolvedValue({
      node: { ok: false, version: '18.0.0', message: 'requires Node 20+' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: false },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: true,
    });
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(1);
      const out = cap.stdout.join('');
      expect(out).toMatch(/requires Node 20/i);
    } finally {
      cap.restore();
    }
  });

  it('exits 1 when Python 3 is missing', async () => {
    runSystemCheckMock.mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: false, message: 'Python 3 not found.' },
      docker: { ok: false },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: true,
    });
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(1);
      const out = cap.stdout.join('');
      expect(out).toMatch(/python/i);
      expect(out).toMatch(/python\.org|brew install/i);
    } finally {
      cap.restore();
    }
  });

  it('warns but exits 0 when Docker is missing (optional)', async () => {
    primeHappyPath();
    runSystemCheckMock.mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: false },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: false,
    });
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toMatch(/docker.*optional|optional.*docker/i);
    } finally {
      cap.restore();
    }
  });

  it('warns but exits 0 when disk space is low', async () => {
    primeHappyPath();
    runSystemCheckMock.mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: true, version: '29.4.0' },
      disk: { ok: false, freeMb: 200, message: 'only 200 MB free' },
      hardFailure: false,
    });
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toMatch(/200 MB|disk/i);
    } finally {
      cap.restore();
    }
  });

  it('writes banner to stdout not stderr', async () => {
    primeHappyPath();
    const cap = capture();
    try {
      await runInit(['--non-interactive', '--agents=cursor']);
      expect(cap.stdout.join('')).toContain('BANNER');
      expect(cap.stderr.join('')).not.toContain('BANNER');
    } finally {
      cap.restore();
    }
  });

  it('returns 2 on unknown flag', async () => {
    const cap = capture();
    try {
      const code = await runInit(['--some-future-flag', 'value']);
      expect(code).toBe(2);
      expect(cap.stderr.join('')).toContain('--some-future-flag');
    } finally {
      cap.restore();
    }
  });

  it('non-interactive path invokes runWarmup(["--all"]) exactly once (no double-call)', async () => {
    primeHappyPath();
    const cap = capture();
    try {
      await runInit(['--non-interactive', '--agents=cursor']);
      expect(runWarmupMock).toHaveBeenCalledTimes(1);
      expect(runWarmupMock.mock.calls[0]?.[0]).toEqual(['--all']);
      // Interactive delegate must not be reached on the non-interactive path.
      expect(runConfigMock).not.toHaveBeenCalled();
    } finally {
      cap.restore();
    }
  });

  describe('interactive (Ink) path', () => {
    let prevTTY: boolean | undefined;
    let prevCI: string | undefined;
    let prevGha: string | undefined;

    beforeEach(() => {
      prevTTY = process.stdout.isTTY;
      prevCI = process.env.CI;
      prevGha = process.env.GITHUB_ACTIONS;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;
      runConfigMock.mockResolvedValue(0);
      runWarmupMock.mockResolvedValue(undefined);
      wasUninstalledMock.mockReturnValue(false);
    });

    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
      if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
      if (prevGha === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prevGha;
    });

    it('runs the wizard then warms up the full tool set exactly once', async () => {
      const cap = capture();
      try {
        const code = await runInit([]);
        expect(code).toBe(0);
        // Wizard delegate ran with --force-wizard.
        expect(runConfigMock).toHaveBeenCalledTimes(1);
        expect(runConfigMock.mock.calls[0]?.[0]).toEqual(['--force-wizard']);
        // Warmup ran once with the full --all set (parity with non-interactive).
        expect(runWarmupMock).toHaveBeenCalledTimes(1);
        expect(runWarmupMock.mock.calls[0]?.[0]).toEqual(['--all']);
      } finally {
        cap.restore();
      }
    });

    it('skips warmup and propagates the code when the wizard exits non-zero', async () => {
      runConfigMock.mockResolvedValue(1);
      const cap = capture();
      try {
        const code = await runInit([]);
        expect(code).toBe(1);
        expect(runWarmupMock).not.toHaveBeenCalled();
      } finally {
        cap.restore();
      }
    });

    it('returns 1 and reports when warmup fails', async () => {
      runWarmupMock.mockRejectedValue(new Error('browser download blocked'));
      const cap = capture();
      try {
        const code = await runInit([]);
        expect(code).toBe(1);
        expect(cap.stderr.join('')).toMatch(/browser download blocked/);
      } finally {
        cap.restore();
      }
    });

    it('skips warmup when the user uninstalled mid-session', async () => {
      // Navigating to the uninstall screen wipes ~/.wigolo; runInit must not
      // re-run warmup afterward or it would recreate everything just removed.
      wasUninstalledMock.mockReturnValue(true);
      const cap = capture();
      try {
        const code = await runInit([]);
        expect(code).toBe(0);
        expect(runConfigMock).toHaveBeenCalledTimes(1);
        expect(runWarmupMock).not.toHaveBeenCalled();
      } finally {
        cap.restore();
      }
    });
  });
});
