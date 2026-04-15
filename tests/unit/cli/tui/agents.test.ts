import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/cli/tui/detect-helpers.js', () => ({
  binaryInPath: vi.fn(),
  dirExists: vi.fn(),
  fileExists: vi.fn(),
  getHome: vi.fn(() => '/home/test'),
  getCwd: vi.fn(() => '/proj'),
}));

import { binaryInPath, dirExists } from '../../../../src/cli/tui/detect-helpers.js';
import { AGENTS, detectAgents } from '../../../../src/cli/tui/agents.js';

function getDescriptor(id: string) {
  const d = AGENTS.find((a) => a.id === id);
  if (!d) throw new Error(`agent ${id} not registered`);
  return d;
}

const ENV = { cwd: '/proj', home: '/home/test' };

describe('Claude Code descriptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects when `claude` binary is on PATH', () => {
    vi.mocked(binaryInPath).mockImplementation((n) => (n === 'claude' ? '/usr/local/bin/claude' : null));
    expect(getDescriptor('claude-code').detect(ENV)).toBe(true);
  });

  it('does NOT detect when binary is missing (no fallback)', () => {
    vi.mocked(binaryInPath).mockReturnValue(null);
    expect(getDescriptor('claude-code').detect(ENV)).toBe(false);
  });

  it('configPath returns null (uses CLI command, not file)', () => {
    expect(getDescriptor('claude-code').configPath(ENV)).toBeNull();
  });

  it('installType is cli-command', () => {
    expect(getDescriptor('claude-code').installType).toBe('cli-command');
  });
});

describe('Cursor descriptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects when project .cursor dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === '/proj/.cursor');
    expect(getDescriptor('cursor').detect(ENV)).toBe(true);
  });

  it('detects when global ~/.cursor dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === '/home/test/.cursor');
    expect(getDescriptor('cursor').detect(ENV)).toBe(true);
  });

  it('detects when `cursor` binary is on PATH', () => {
    vi.mocked(binaryInPath).mockImplementation((n) => (n === 'cursor' ? '/usr/local/bin/cursor' : null));
    vi.mocked(dirExists).mockReturnValue(false);
    expect(getDescriptor('cursor').detect(ENV)).toBe(true);
  });

  it('does NOT detect when nothing matches', () => {
    vi.mocked(dirExists).mockReturnValue(false);
    vi.mocked(binaryInPath).mockReturnValue(null);
    expect(getDescriptor('cursor').detect(ENV)).toBe(false);
  });

  it('configPath prefers project .cursor/mcp.json when project dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === '/proj/.cursor');
    expect(getDescriptor('cursor').configPath(ENV)).toBe('/proj/.cursor/mcp.json');
  });

  it('configPath falls back to global when project dir missing', () => {
    vi.mocked(dirExists).mockReturnValue(false);
    expect(getDescriptor('cursor').configPath(ENV)).toBe('/home/test/.cursor/mcp.json');
  });
});

describe('VS Code descriptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects when project .vscode dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === '/proj/.vscode');
    expect(getDescriptor('vscode').detect(ENV)).toBe(true);
  });

  it('detects when `code` binary is on PATH', () => {
    vi.mocked(binaryInPath).mockImplementation((n) => (n === 'code' ? '/usr/local/bin/code' : null));
    vi.mocked(dirExists).mockReturnValue(false);
    expect(getDescriptor('vscode').detect(ENV)).toBe(true);
  });

  it('does NOT detect when nothing matches', () => {
    vi.mocked(dirExists).mockReturnValue(false);
    vi.mocked(binaryInPath).mockReturnValue(null);
    expect(getDescriptor('vscode').detect(ENV)).toBe(false);
  });

  it('configPath prefers project .vscode/mcp.json', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === '/proj/.vscode');
    expect(getDescriptor('vscode').configPath(ENV)).toBe('/proj/.vscode/mcp.json');
  });

  it('configPath falls back to ~/.vscode/mcp.json', () => {
    vi.mocked(dirExists).mockReturnValue(false);
    expect(getDescriptor('vscode').configPath(ENV)).toBe('/home/test/.vscode/mcp.json');
  });
});

describe('Zed descriptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects when ~/.config/zed dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === '/home/test/.config/zed');
    expect(getDescriptor('zed').detect(ENV)).toBe(true);
  });

  it('detects when `zed` binary is on PATH', () => {
    vi.mocked(binaryInPath).mockImplementation((n) => (n === 'zed' ? '/usr/local/bin/zed' : null));
    vi.mocked(dirExists).mockReturnValue(false);
    expect(getDescriptor('zed').detect(ENV)).toBe(true);
  });

  it('does NOT detect when nothing matches', () => {
    vi.mocked(dirExists).mockReturnValue(false);
    vi.mocked(binaryInPath).mockReturnValue(null);
    expect(getDescriptor('zed').detect(ENV)).toBe(false);
  });

  it('configPath returns ~/.config/zed/settings.json', () => {
    expect(getDescriptor('zed').configPath(ENV)).toBe('/home/test/.config/zed/settings.json');
  });
});

// detectAgents() composer assertions and last 4 agents added in Task 4
void detectAgents;
