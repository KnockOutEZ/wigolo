import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { mergeMcpJson, removeMcpJson, readAsset } from './utils.js';

const MCP_KEY_PATH = ['mcpServers', 'wigolo'];

function cursorDir(): string {
  return join(homedir(), '.cursor');
}

function detect(): boolean {
  const home = homedir();
  return (
    existsSync(join(home, '.cursor')) ||
    (() => {
      try {
        execSync('which cursor', { stdio: ['pipe', 'pipe', 'pipe'] });
        return true;
      } catch {
        return false;
      }
    })()
  );
}

async function installMcp(cmd: { command: string; args: string[] }): Promise<void> {
  const configPath = join(cursorDir(), 'mcp.json');
  mergeMcpJson(configPath, { command: cmd.command, args: cmd.args }, MCP_KEY_PATH);
}

async function installInstructions(): Promise<void> {
  const content = readAsset('blocks/cursor/wigolo.mdc');
  const rulesDir = join(cursorDir(), 'rules');
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, 'wigolo.mdc'), content, 'utf-8');
}

async function uninstall(): Promise<{ removed: string[] }> {
  const removed: string[] = [];

  const configPath = join(cursorDir(), 'mcp.json');
  if (existsSync(configPath)) {
    removeMcpJson(configPath, MCP_KEY_PATH);
    removed.push('~/.cursor/mcp.json (wigolo entry)');
  }

  const rulesFile = join(cursorDir(), 'rules', 'wigolo.mdc');
  if (existsSync(rulesFile)) {
    rmSync(rulesFile);
    removed.push('~/.cursor/rules/wigolo.mdc');
  }

  return { removed };
}

export const cursorHandler = {
  id: 'cursor' as const,
  displayName: 'Cursor',
  supportsSkills: false,
  supportsCommands: false,
  detect,
  installMcp,
  installInstructions,
  uninstall,
};
