import { describe, expect, it, vi, beforeEach } from 'vitest';

const { detectAgentsMock, selectAgentsMock, applyConfigsMock, printAddMcpBannerMock } = vi.hoisted(() => ({
  detectAgentsMock: vi.fn(),
  selectAgentsMock: vi.fn(),
  applyConfigsMock: vi.fn(),
  printAddMcpBannerMock: vi.fn(),
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
vi.mock('../../../src/cli/tui/banner.js', () => ({
  printAddMcpBanner: printAddMcpBannerMock,
}));

import { runSetupMcp } from '../../../src/cli/setup-mcp.js';

beforeEach(() => {
  detectAgentsMock.mockReset().mockReturnValue([
    { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file', configPath: '/h/.cursor/mcp.json' },
  ]);
  selectAgentsMock.mockReset().mockResolvedValue([]);
  applyConfigsMock.mockReset().mockResolvedValue([
    { id: 'cursor', displayName: 'Cursor', ok: true, code: 'OK', configPath: '/h/.cursor/mcp.json' },
  ]);
});

describe('runSetupMcp mcp --non-interactive', () => {
  it('skips selectAgents and calls applyConfigs directly', async () => {
    const code = await runSetupMcp(['mcp', '--non-interactive', '--agents=cursor']);
    expect(code).toBe(0);
    expect(selectAgentsMock).not.toHaveBeenCalled();
    expect(applyConfigsMock).toHaveBeenCalledWith(
      expect.any(Array),
      ['cursor'],
      expect.any(Object),
    );
  });

  it('returns 2 when --non-interactive is supplied without --agents', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runSetupMcp(['mcp', '--non-interactive']);
    writeMock.mockRestore();
    expect(code).toBe(2);
  });

  it('returns 2 on unknown agent id', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runSetupMcp(['mcp', '--non-interactive', '--agents=not-real']);
    writeMock.mockRestore();
    expect(code).toBe(2);
  });

  it('returns 2 on unknown flag', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runSetupMcp(['mcp', '--skip-verify']);
    writeMock.mockRestore();
    expect(code).toBe(2);
  });

  it('returns 0 on --help', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runSetupMcp(['mcp', '--help']);
    writeMock.mockRestore();
    expect(code).toBe(0);
  });
});
