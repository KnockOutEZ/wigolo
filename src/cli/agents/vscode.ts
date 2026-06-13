import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { mergeMcpJson, removeMcpJson, mergeBlock, removeBlock, readAsset } from './utils.js';

const MCP_KEY_PATH = ['servers', 'wigolo'];
const INSTRUCTIONS_FILE = '.github/copilot-instructions.md';

/**
 * Resolve VS Code's global user-config directory per platform.
 *
 * VS Code reads globally-installed MCP servers from the `mcp.json` in its user
 * config dir — NOT from `~/.vscode/mcp.json` (issue #106). Writing to the wrong
 * dir means wigolo never appears under Extensions > MCP Servers.
 *
 * On Linux we honour the XDG Base Directory spec ($XDG_CONFIG_HOME, falling back
 * to ~/.config when empty/unset), and prefer an already-present Flatpak/Snap
 * config dir when one exists so sandboxed installs land where VS Code reads.
 */
export function vscodeUserDir(home?: string): string {
  const resolvedHome = home ?? homedir();
  const os = platform();

  if (os === 'darwin') {
    return join(resolvedHome, 'Library', 'Application Support', 'Code', 'User');
  }

  if (os === 'win32') {
    const appData = process.env.APPDATA;
    const base = appData && appData.length > 0
      ? appData
      : join(resolvedHome, 'AppData', 'Roaming');
    return join(base, 'Code', 'User');
  }

  // Linux (and other POSIX): prefer an existing Flatpak/Snap config dir, else
  // the XDG standard path.
  const flatpak = join(resolvedHome, '.var', 'app', 'com.visualstudio.code', 'config', 'Code', 'User');
  if (existsSync(flatpak)) return flatpak;

  const snap = join(resolvedHome, 'snap', 'code', 'current', '.config', 'Code', 'User');
  if (existsSync(snap)) return snap;

  const xdg = process.env.XDG_CONFIG_HOME;
  const configBase = xdg && xdg.length > 0 ? xdg : join(resolvedHome, '.config');
  return join(configBase, 'Code', 'User');
}

function vscodeConfigPath(): string {
  return join(vscodeUserDir(), 'mcp.json');
}

function detect(): boolean {
  const home = homedir();
  if (existsSync(join(home, '.vscode'))) return true;
  try {
    execSync('which code', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

async function installMcp(cmd: { command: string; args: string[] }): Promise<void> {
  const configPath = vscodeConfigPath();
  mkdirSync(vscodeUserDir(), { recursive: true });
  mergeMcpJson(
    configPath,
    { command: cmd.command, args: cmd.args, type: 'stdio' },
    MCP_KEY_PATH,
  );
}

async function installInstructions(): Promise<void> {
  const block = readAsset('blocks/vscode/copilot-instructions.md.block');
  // Install to project-level .github/copilot-instructions.md (CWD)
  const target = join(process.cwd(), INSTRUCTIONS_FILE);
  mkdirSync(join(process.cwd(), '.github'), { recursive: true });
  mergeBlock(target, block);
}

async function uninstall(): Promise<{ removed: string[] }> {
  const removed: string[] = [];

  const configPath = vscodeConfigPath();
  if (existsSync(configPath)) {
    removeMcpJson(configPath, MCP_KEY_PATH);
    removed.push(`${configPath} (wigolo entry)`);
  }

  const instructionsFile = join(process.cwd(), INSTRUCTIONS_FILE);
  if (existsSync(instructionsFile) && removeBlock(instructionsFile)) {
    removed.push('.github/copilot-instructions.md block');
  }

  return { removed };
}

export const vscodeHandler = {
  id: 'vscode' as const,
  displayName: 'VS Code (Copilot)',
  supportsSkills: false,
  supportsCommands: false,
  detect,
  installMcp,
  installInstructions,
  uninstall,
};
