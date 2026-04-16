import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  runSystemCheckMock,
  renderBannerMock,
  getPackageVersionMock,
  runWarmupMock,
  detectAgentsMock,
  selectAgentsMock,
  applyConfigsMock,
  runVerifyMock,
} = vi.hoisted(() => ({
  runSystemCheckMock: vi.fn(),
  renderBannerMock: vi.fn(() => 'BANNER\n'),
  getPackageVersionMock: vi.fn(() => '0.6.3'),
  runWarmupMock: vi.fn(),
  detectAgentsMock: vi.fn(),
  selectAgentsMock: vi.fn(),
  applyConfigsMock: vi.fn(),
  runVerifyMock: vi.fn(),
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
}

describe('runInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderBannerMock.mockReturnValue('BANNER\n');
    getPackageVersionMock.mockReturnValue('0.6.3');
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
});
