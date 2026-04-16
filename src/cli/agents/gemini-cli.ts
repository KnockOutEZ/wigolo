import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { mergeMcpJson, removeMcpJson, mergeBlock, removeBlock, readAsset } from './utils.js';

const MCP_KEY_PATH = ['mcpServers', 'wigolo'];

function geminiDir(): string {
  return join(homedir(), '.gemini');
}

function detect(): boolean {
  if (existsSync(geminiDir())) return true;
  try {
    execSync('which gemini', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

async function installMcp(cmd: { command: string; args: string[] }): Promise<void> {
  const configPath = join(geminiDir(), 'settings.json');
  mkdirSync(geminiDir(), { recursive: true });
  mergeMcpJson(configPath, { command: cmd.command, args: cmd.args }, MCP_KEY_PATH);
}

async function installInstructions(): Promise<void> {
  const block = readAsset('blocks/gemini-cli/GEMINI.md.block');
  // Gemini CLI looks for GEMINI.md in CWD or home directory
  const target = join(process.cwd(), 'GEMINI.md');
  mergeBlock(target, block);
}

async function uninstall(): Promise<{ removed: string[] }> {
  const removed: string[] = [];

  const configPath = join(geminiDir(), 'settings.json');
  if (existsSync(configPath)) {
    removeMcpJson(configPath, MCP_KEY_PATH);
    removed.push('~/.gemini/settings.json (wigolo entry)');
  }

  const instructionsFile = join(process.cwd(), 'GEMINI.md');
  if (existsSync(instructionsFile)) {
    removeBlock(instructionsFile);
    removed.push('GEMINI.md block');
  }

  return { removed };
}

export const geminiCliHandler = {
  id: 'gemini-cli' as const,
  displayName: 'Gemini CLI',
  supportsSkills: false,
  supportsCommands: false,
  detect,
  installMcp,
  installInstructions,
  uninstall,
};
