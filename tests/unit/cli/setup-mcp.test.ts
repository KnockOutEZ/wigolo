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
    constructor(msg?: string) {
      super(msg ?? 'not a TTY');
      this.name = 'NotTtyError';
    }
  },
}));

vi.mock('../../../src/cli/tui/config-writer.js', () => ({
  applyConfigs: applyConfigsMock,
}));

vi.mock('../../../src/cli/tui/banner.js', () => ({
  printAddMcpBanner: printAddMcpBannerMock,
}));

import { runSetupMcp } from '../../../src/cli/setup-mcp.js';
import { NotTtyError } from '../../../src/cli/tui/select-agents.js';

beforeEach(() => {
  detectAgentsMock.mockReset();
  selectAgentsMock.mockReset();
  applyConfigsMock.mockReset();
  printAddMcpBannerMock.mockReset();
});

describe('runSetupMcp — usage', () => {
  it('returns 2 with usage when subcommand is missing', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runSetupMcp([]);
    writeMock.mockRestore();
    expect(code).toBe(2);
    expect(detectAgentsMock).not.toHaveBeenCalled();
  });

  it('returns 2 with usage on unknown subcommand', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runSetupMcp(['nonsense']);
    writeMock.mockRestore();
    expect(code).toBe(2);
  });
});

describe('runSetupMcp — happy path', () => {
  it('prints the banner, detects, prompts, applies configs and returns 0', async () => {
    detectAgentsMock.mockResolvedValue([
      { id: 'claude-code', displayName: 'Claude Code', detected: true, installType: 'cli-command' },
      { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file' },
    ]);
    selectAgentsMock.mockResolvedValue(['claude-code', 'cursor']);
    applyConfigsMock.mockResolvedValue([
      { id: 'claude-code', displayName: 'Claude Code', ok: true, code: 'OK', configPath: null },
      { id: 'cursor', displayName: 'Cursor', ok: true, code: 'OK', configPath: '/home/u/.cursor/mcp.json' },
    ]);

    const code = await runSetupMcp(['mcp']);

    expect(code).toBe(0);
    expect(printAddMcpBannerMock).toHaveBeenCalledTimes(1);
    expect(detectAgentsMock).toHaveBeenCalledTimes(1);
    expect(selectAgentsMock).toHaveBeenCalledWith([
      { id: 'claude-code', displayName: 'Claude Code', detected: true, installType: 'cli-command' },
      { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file' },
    ]);
    expect(applyConfigsMock).toHaveBeenCalledWith(
      expect.any(Array),
      ['claude-code', 'cursor'],
      expect.any(Object),
    );
  });
});

describe('runSetupMcp — no detected agents', () => {
  it('returns 0 and prints an empty-state note without prompting', async () => {
    detectAgentsMock.mockResolvedValue([]);

    const code = await runSetupMcp(['mcp']);

    expect(code).toBe(0);
    expect(selectAgentsMock).not.toHaveBeenCalled();
    expect(applyConfigsMock).not.toHaveBeenCalled();
  });
});

describe('runSetupMcp — user selects nothing', () => {
  it('returns 0 without calling applyConfigs', async () => {
    detectAgentsMock.mockResolvedValue([
      { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file' },
    ]);
    selectAgentsMock.mockResolvedValue([]);

    const code = await runSetupMcp(['mcp']);

    expect(code).toBe(0);
    expect(applyConfigsMock).not.toHaveBeenCalled();
  });
});

describe('runSetupMcp — non-TTY', () => {
  it('returns 2 when NotTtyError is thrown by selectAgents', async () => {
    detectAgentsMock.mockResolvedValue([
      { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file' },
    ]);
    selectAgentsMock.mockRejectedValue(new NotTtyError());

    const code = await runSetupMcp(['mcp']);

    expect(code).toBe(2);
  });
});

describe('runSetupMcp — writer errors', () => {
  it('returns 1 when any agent applyConfigs status is error', async () => {
    detectAgentsMock.mockResolvedValue([
      { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file' },
    ]);
    selectAgentsMock.mockResolvedValue(['cursor']);
    applyConfigsMock.mockResolvedValue([
      { id: 'cursor', displayName: 'Cursor', ok: false, code: 'PERMISSION_DENIED', configPath: '/home/u/.cursor/mcp.json', message: 'EACCES' },
    ]);

    const code = await runSetupMcp(['mcp']);

    expect(code).toBe(1);
  });
});

describe('entrypoint dispatch', () => {
  it('is reachable via "setup mcp" through parseCommand wiring', async () => {
    const { parseCommand } = await import('../../../src/cli/index.js');
    const parsed = parseCommand(['setup', 'mcp']);
    expect(parsed.command).toBe('setup');
    expect(parsed.args).toEqual(['mcp']);
  });
});
