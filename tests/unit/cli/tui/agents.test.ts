import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

vi.mock('../../../../src/cli/tui/detect-helpers.js', () => ({
  binaryInPath: vi.fn(),
  dirExists: vi.fn(),
  fileExists: vi.fn(),
  getHome: vi.fn(() => '/home/test'),
  getCwd: vi.fn(() => '/proj'),
}));

// vscodeUserDir's platform/env resolution is exercised in agents/vscode.test.ts.
// Here we only assert the descriptor delegates to it, so stub it to a stable dir.
const { vscodeUserDirMock } = vi.hoisted(() => ({
  vscodeUserDirMock: vi.fn((home?: string) => `${home ?? '/home/test'}/.config/Code/User`),
}));
vi.mock('../../../../src/cli/agents/vscode.js', () => ({
  vscodeUserDir: vscodeUserDirMock,
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
    vi.mocked(dirExists).mockImplementation((p) => p === join('/proj', '.cursor'));
    expect(getDescriptor('cursor').detect(ENV)).toBe(true);
  });

  it('detects when global ~/.cursor dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === join('/home/test', '.cursor'));
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
    vi.mocked(dirExists).mockImplementation((p) => p === join('/proj', '.cursor'));
    expect(getDescriptor('cursor').configPath(ENV)).toBe(join('/proj', '.cursor', 'mcp.json'));
  });

  it('configPath falls back to global when project dir missing', () => {
    vi.mocked(dirExists).mockReturnValue(false);
    expect(getDescriptor('cursor').configPath(ENV)).toBe(join('/home/test', '.cursor', 'mcp.json'));
  });
});

describe('VS Code descriptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects when project .vscode dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === join('/proj', '.vscode'));
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

  it('configPath routes through vscodeUserDir(home), never the project/cwd dir', () => {
    // VS Code reads global MCP servers from the per-user Code/User dir, not the
    // project or ~/.vscode dir — configPath must delegate to vscodeUserDir(home)
    // even when a project .vscode dir is present.
    vi.mocked(dirExists).mockImplementation((p) => p === join('/proj', '.vscode'));
    const result = getDescriptor('vscode').configPath(ENV);
    expect(vscodeUserDirMock).toHaveBeenCalledWith('/home/test');
    expect(result).toBe(join('/home/test/.config/Code/User', 'mcp.json'));
  });

  it('configPath is home-derived and independent of cwd', () => {
    vi.mocked(dirExists).mockReturnValue(false);
    const result = getDescriptor('vscode').configPath({ cwd: '/some/other/cwd', home: '/home/test' });
    expect(result).toBe(join('/home/test/.config/Code/User', 'mcp.json'));
  });
});

describe('Zed descriptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects when ~/.config/zed dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === join('/home/test', '.config', 'zed'));
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
    expect(getDescriptor('zed').configPath(ENV)).toBe(join('/home/test', '.config', 'zed', 'settings.json'));
  });
});

describe('Gemini CLI descriptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects when `gemini` binary is on PATH', () => {
    vi.mocked(binaryInPath).mockImplementation((n) => (n === 'gemini' ? '/usr/local/bin/gemini' : null));
    expect(getDescriptor('gemini-cli').detect(ENV)).toBe(true);
  });

  it('detects when ~/.gemini dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === join('/home/test', '.gemini'));
    expect(getDescriptor('gemini-cli').detect(ENV)).toBe(true);
  });

  it('does NOT detect when both missing', () => {
    vi.mocked(binaryInPath).mockReturnValue(null);
    vi.mocked(dirExists).mockReturnValue(false);
    expect(getDescriptor('gemini-cli').detect(ENV)).toBe(false);
  });

  it('configPath returns ~/.gemini/settings.json', () => {
    expect(getDescriptor('gemini-cli').configPath(ENV)).toBe(join('/home/test', '.gemini', 'settings.json'));
  });
});

describe('Windsurf descriptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects when ~/.codeium/windsurf dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === join('/home/test', '.codeium', 'windsurf'));
    expect(getDescriptor('windsurf').detect(ENV)).toBe(true);
  });

  it('detects when ~/.windsurf legacy dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === join('/home/test', '.windsurf'));
    expect(getDescriptor('windsurf').detect(ENV)).toBe(true);
  });

  it('detects when `windsurf` binary is on PATH', () => {
    vi.mocked(binaryInPath).mockImplementation((n) => (n === 'windsurf' ? '/usr/local/bin/windsurf' : null));
    expect(getDescriptor('windsurf').detect(ENV)).toBe(true);
  });

  it('configPath prefers ~/.codeium/windsurf/mcp_config.json', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === join('/home/test', '.codeium', 'windsurf'));
    expect(getDescriptor('windsurf').configPath(ENV)).toBe(join('/home/test', '.codeium', 'windsurf', 'mcp_config.json'));
  });

  it('configPath falls back to ~/.codeium/windsurf/mcp_config.json', () => {
    vi.mocked(dirExists).mockReturnValue(false);
    expect(getDescriptor('windsurf').configPath(ENV)).toBe(join('/home/test', '.codeium', 'windsurf', 'mcp_config.json'));
  });
});

describe('Codex descriptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects when `codex` binary is on PATH', () => {
    vi.mocked(binaryInPath).mockImplementation((n) => (n === 'codex' ? '/usr/local/bin/codex' : null));
    expect(getDescriptor('codex').detect(ENV)).toBe(true);
  });

  it('detects when ~/.codex dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === join('/home/test', '.codex'));
    expect(getDescriptor('codex').detect(ENV)).toBe(true);
  });

  it('configPath returns ~/.codex/config.toml', () => {
    expect(getDescriptor('codex').configPath(ENV)).toBe(join('/home/test', '.codex', 'config.toml'));
  });

  it('installType is config-toml', () => {
    expect(getDescriptor('codex').installType).toBe('config-toml');
  });
});

describe('OpenCode descriptor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects when `opencode` binary is on PATH', () => {
    vi.mocked(binaryInPath).mockImplementation((n) => (n === 'opencode' ? '/usr/local/bin/opencode' : null));
    expect(getDescriptor('opencode').detect(ENV)).toBe(true);
  });

  it('detects when ~/.config/opencode dir exists', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === join('/home/test', '.config', 'opencode'));
    expect(getDescriptor('opencode').detect(ENV)).toBe(true);
  });

  it('configPath returns ~/.config/opencode/config.json', () => {
    expect(getDescriptor('opencode').configPath(ENV)).toBe(join('/home/test', '.config', 'opencode', 'config.json'));
  });
});

describe('detectAgents()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns one entry per registered agent', () => {
    vi.mocked(binaryInPath).mockReturnValue(null);
    vi.mocked(dirExists).mockReturnValue(false);
    const agents = detectAgents();
    expect(agents).toHaveLength(8);
    const ids = agents.map((a) => a.id).sort();
    expect(ids).toEqual([
      'claude-code', 'codex', 'cursor', 'gemini-cli',
      'opencode', 'vscode', 'windsurf', 'zed',
    ]);
  });

  it('marks detected: true only for agents whose detect() returns true', () => {
    vi.mocked(binaryInPath).mockImplementation((n) => (n === 'claude' ? '/x' : null));
    vi.mocked(dirExists).mockReturnValue(false);
    const agents = detectAgents();
    const claudeAgent = agents.find((a) => a.id === 'claude-code');
    expect(claudeAgent?.detected).toBe(true);
    const cursorAgent = agents.find((a) => a.id === 'cursor');
    expect(cursorAgent?.detected).toBe(false);
  });

  it('always populates configPath (or null for cli-command)', () => {
    vi.mocked(binaryInPath).mockReturnValue(null);
    vi.mocked(dirExists).mockReturnValue(false);
    const agents = detectAgents();
    const claudeAgent = agents.find((a) => a.id === 'claude-code');
    expect(claudeAgent?.configPath).toBeNull();
    const cursorAgent = agents.find((a) => a.id === 'cursor');
    expect(cursorAgent?.configPath).toMatch(/\.cursor[\\/]mcp\.json$/);
  });

  it('honors cwd and home overrides', () => {
    vi.mocked(dirExists).mockImplementation((p) => p === join('/custom/cwd', '.cursor'));
    vi.mocked(binaryInPath).mockReturnValue(null);
    const agents = detectAgents({ cwd: '/custom/cwd', home: '/custom/home' });
    const cursorAgent = agents.find((a) => a.id === 'cursor');
    expect(cursorAgent?.configPath).toBe(join('/custom/cwd', '.cursor', 'mcp.json'));
  });

  it('preserves AGENTS registration order in the returned array', () => {
    vi.mocked(binaryInPath).mockReturnValue(null);
    vi.mocked(dirExists).mockReturnValue(false);
    const agents = detectAgents();
    expect(agents[0].id).toBe('claude-code');
    expect(agents[1].id).toBe('cursor');
    expect(agents[2].id).toBe('vscode');
    expect(agents[3].id).toBe('zed');
    expect(agents[4].id).toBe('gemini-cli');
    expect(agents[5].id).toBe('windsurf');
    expect(agents[6].id).toBe('codex');
    expect(agents[7].id).toBe('opencode');
  });
});
