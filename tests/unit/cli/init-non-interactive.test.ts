import { describe, expect, it, vi, beforeEach } from 'vitest';

const { runWarmupMock, detectAgentsMock, selectAgentsMock, applyConfigsMock, runVerifyMock, systemCheckMock } = vi.hoisted(() => ({
  runWarmupMock: vi.fn(),
  detectAgentsMock: vi.fn(),
  selectAgentsMock: vi.fn(),
  applyConfigsMock: vi.fn(),
  runVerifyMock: vi.fn(),
  systemCheckMock: vi.fn(),
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
vi.mock('../../../src/cli/tui/system-check.js', () => ({
  runSystemCheck: systemCheckMock,
}));
vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/data' }),
}));

import { runInit } from '../../../src/cli/init.js';

beforeEach(() => {
  runWarmupMock.mockReset().mockResolvedValue(undefined);
  detectAgentsMock.mockReset().mockReturnValue([
    { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file', configPath: '/h/.cursor/mcp.json' },
    { id: 'claude-code', displayName: 'Claude Code', detected: true, installType: 'cli-command', configPath: null },
  ]);
  selectAgentsMock.mockReset().mockResolvedValue([]);
  applyConfigsMock.mockReset().mockResolvedValue([
    { id: 'cursor', displayName: 'Cursor', ok: true, code: 'OK', configPath: '/h/.cursor/mcp.json' },
  ]);
  runVerifyMock.mockReset().mockResolvedValue({ allPassed: true });
  systemCheckMock.mockReset().mockResolvedValue({
    node: { ok: true, version: '22.0.0' },
    python: { ok: true, binary: 'python3', version: '3.12.0' },
    docker: { ok: true, version: '29.0.0' },
    disk: { ok: true, freeMb: 50000 },
    hardFailure: false,
  });
});

describe('runInit --non-interactive', () => {
  it('skips selectAgents and calls applyConfigs with the flag ids', async () => {
    const code = await runInit(['--non-interactive', '--agents=cursor']);

    expect(code).toBe(0);
    expect(selectAgentsMock).not.toHaveBeenCalled();
    expect(applyConfigsMock).toHaveBeenCalledWith(
      expect.any(Array),
      ['cursor'],
      expect.any(Object),
    );
  });

  it('skips runVerify when --skip-verify is set', async () => {
    await runInit(['--non-interactive', '--agents=cursor', '--skip-verify']);
    expect(runVerifyMock).not.toHaveBeenCalled();
  });

  it('runs runVerify when --skip-verify is not set', async () => {
    await runInit(['--non-interactive', '--agents=cursor']);
    expect(runVerifyMock).toHaveBeenCalledTimes(1);
  });

  it('returns 2 on unknown agent id', async () => {
    const code = await runInit(['--non-interactive', '--agents=not-real']);
    expect(code).toBe(2);
    expect(runWarmupMock).not.toHaveBeenCalled();
  });

  it('returns 2 on unknown flag', async () => {
    const code = await runInit(['--bogus']);
    expect(code).toBe(2);
  });

  it('returns 0 and prints usage on --help', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runInit(['--help']);
    writeMock.mockRestore();
    expect(code).toBe(0);
    expect(runWarmupMock).not.toHaveBeenCalled();
  });
});
