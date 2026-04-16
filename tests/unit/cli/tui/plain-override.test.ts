import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { autoReporterMock } = vi.hoisted(() => ({
  autoReporterMock: vi.fn(),
}));

vi.mock('../../../../src/cli/tui/reporter-auto.js', () => ({
  autoReporter: autoReporterMock,
}));

vi.mock('../../../../src/cli/warmup.js', () => ({
  runWarmup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../src/cli/tui/agents.js', () => ({
  detectAgents: vi.fn(() => [
    { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file', configPath: '/h/.cursor/mcp.json' },
  ]),
}));
vi.mock('../../../../src/cli/tui/select-agents.js', () => ({
  selectAgents: vi.fn().mockResolvedValue([]),
  NotTtyError: class NotTtyError extends Error {},
}));
vi.mock('../../../../src/cli/tui/config-writer.js', () => ({
  applyConfigs: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../../src/cli/tui/verify.js', () => ({
  runVerify: vi.fn().mockResolvedValue({ allPassed: true }),
}));
vi.mock('../../../../src/cli/tui/banner.js', () => ({
  renderBanner: vi.fn(() => 'BANNER\n'),
  printAddMcpBanner: vi.fn(),
}));
vi.mock('../../../../src/cli/tui/version.js', () => ({
  getPackageVersion: vi.fn(() => '0.6.3'),
}));
vi.mock('../../../../src/cli/tui/system-check.js', () => ({
  runSystemCheck: vi.fn().mockResolvedValue({
    node: { ok: true, version: '22.0.0' },
    python: { ok: true, binary: 'python3', version: '3.12.0' },
    docker: { ok: true, version: '29.0.0' },
    disk: { ok: true, freeMb: 50000 },
    hardFailure: false,
  }),
}));
vi.mock('../../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/data' }),
}));

import { runInit } from '../../../../src/cli/init.js';

beforeEach(() => {
  autoReporterMock.mockReset().mockReturnValue({
    start: () => {}, update: () => {}, progress: () => {},
    success: () => {}, fail: () => {}, note: () => {}, finish: () => {},
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('runInit — reporter selection', () => {
  it('passes plain=true to autoReporter when --plain is set', async () => {
    await runInit(['--non-interactive', '--agents=cursor', '--plain']);
    expect(autoReporterMock).toHaveBeenCalledWith(expect.objectContaining({ plain: true }));
  });

  it('passes plain=false when --plain is not set', async () => {
    await runInit(['--non-interactive', '--agents=cursor']);
    expect(autoReporterMock).toHaveBeenCalledWith(expect.objectContaining({ plain: false }));
  });
});
