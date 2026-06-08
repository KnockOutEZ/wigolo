import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn(() => tmpHome),
    platform: vi.fn(() => 'linux'),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';

let tmpHome: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  tmpHome = join(tmpdir(), `wigolo-vscode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  vi.mocked(homedir).mockReturnValue(tmpHome);
  vi.mocked(platform).mockReturnValue('linux');
  // Wipe the XDG / APPDATA env so each test sets its own.
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  process.env = { ...savedEnv };
  vi.clearAllMocks();
  vi.resetModules();
});

/**
 * WHY: VS Code reads global MCP servers from its platform user-config dir, NOT
 * from ~/.vscode/mcp.json. Writing to the wrong dir means VS Code never shows
 * wigolo under Extensions > MCP Servers (issue #106). Each test pins a platform
 * and asserts the config lands where VS Code will actually read it.
 */
describe('vscodeHandler.installMcp — platform config path', () => {
  it('Linux: writes to $XDG_CONFIG_HOME/Code/User/mcp.json when XDG is set', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const xdg = join(tmpHome, 'xdg-config');
    process.env.XDG_CONFIG_HOME = xdg;
    const { vscodeHandler } = await import('../../../../src/cli/agents/vscode.js');
    await vscodeHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    const cfgPath = join(xdg, 'Code', 'User', 'mcp.json');
    expect(existsSync(cfgPath)).toBe(true);
    // The legacy wrong path must NOT be written.
    expect(existsSync(join(tmpHome, '.vscode', 'mcp.json'))).toBe(false);
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(parsed.servers.wigolo.command).toBe('npx');
    expect(parsed.servers.wigolo.type).toBe('stdio');
  });

  it('Linux: falls back to ~/.config/Code/User/mcp.json when XDG_CONFIG_HOME is unset', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { vscodeHandler } = await import('../../../../src/cli/agents/vscode.js');
    await vscodeHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    const cfgPath = join(tmpHome, '.config', 'Code', 'User', 'mcp.json');
    expect(existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(parsed.servers.wigolo).toBeDefined();
  });

  it('Linux: ignores empty XDG_CONFIG_HOME and falls back to ~/.config', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    process.env.XDG_CONFIG_HOME = '';
    const { vscodeHandler } = await import('../../../../src/cli/agents/vscode.js');
    await vscodeHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    const cfgPath = join(tmpHome, '.config', 'Code', 'User', 'mcp.json');
    expect(existsSync(cfgPath)).toBe(true);
  });

  it('macOS: writes to ~/Library/Application Support/Code/User/mcp.json', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    vi.mocked(platform).mockReturnValue('darwin');
    const { vscodeHandler } = await import('../../../../src/cli/agents/vscode.js');
    await vscodeHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    const cfgPath = join(tmpHome, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    expect(existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(parsed.servers.wigolo).toBeDefined();
  });

  it('Windows: writes to %APPDATA%/Code/User/mcp.json', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    vi.mocked(platform).mockReturnValue('win32');
    const appData = join(tmpHome, 'AppData', 'Roaming');
    process.env.APPDATA = appData;
    const { vscodeHandler } = await import('../../../../src/cli/agents/vscode.js');
    await vscodeHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    const cfgPath = join(appData, 'Code', 'User', 'mcp.json');
    expect(existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(parsed.servers.wigolo).toBeDefined();
  });
});

describe('vscodeHandler.installMcp — Flatpak/Snap detection (Linux)', () => {
  it('prefers an existing Flatpak config dir over the standard XDG path', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const flatpakDir = join(tmpHome, '.var', 'app', 'com.visualstudio.code', 'config', 'Code', 'User');
    mkdirSync(flatpakDir, { recursive: true });
    const { vscodeHandler } = await import('../../../../src/cli/agents/vscode.js');
    await vscodeHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    expect(existsSync(join(flatpakDir, 'mcp.json'))).toBe(true);
    // Standard path must not be created when Flatpak install is present.
    expect(existsSync(join(tmpHome, '.config', 'Code', 'User', 'mcp.json'))).toBe(false);
  });

  it('prefers an existing Snap config dir over the standard XDG path', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const snapDir = join(tmpHome, 'snap', 'code', 'current', '.config', 'Code', 'User');
    mkdirSync(snapDir, { recursive: true });
    const { vscodeHandler } = await import('../../../../src/cli/agents/vscode.js');
    await vscodeHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    expect(existsSync(join(snapDir, 'mcp.json'))).toBe(true);
    expect(existsSync(join(tmpHome, '.config', 'Code', 'User', 'mcp.json'))).toBe(false);
  });
});

describe('vscodeHandler.uninstall', () => {
  it('removes the wigolo entry from the platform config path', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { vscodeHandler } = await import('../../../../src/cli/agents/vscode.js');
    await vscodeHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    const cfgPath = join(tmpHome, '.config', 'Code', 'User', 'mcp.json');
    expect(existsSync(cfgPath)).toBe(true);
    const result = await vscodeHandler.uninstall();
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(parsed.servers?.wigolo).toBeUndefined();
    expect(result.removed.length).toBeGreaterThan(0);
  });
});

describe('vscodeHandler metadata', () => {
  it('has id=vscode, supportsSkills=false', async () => {
    const { vscodeHandler } = await import('../../../../src/cli/agents/vscode.js');
    expect(vscodeHandler.id).toBe('vscode');
    expect(vscodeHandler.supportsSkills).toBe(false);
    expect(vscodeHandler.supportsCommands).toBe(false);
  });
});
