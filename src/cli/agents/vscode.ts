import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { mergeMcpJson, removeMcpJson, mergeBlock, removeBlock, readAsset } from './utils.js';

const MCP_KEY_PATH = ['servers', 'wigolo'];
const INSTRUCTIONS_FILE = '.github/copilot-instructions.md';

function vscodeConfigPath(): string {
  return join(homedir(), '.vscode', 'mcp.json');
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
  mkdirSync(join(homedir(), '.vscode'), { recursive: true });
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
    removed.push('~/.vscode/mcp.json (wigolo entry)');
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
