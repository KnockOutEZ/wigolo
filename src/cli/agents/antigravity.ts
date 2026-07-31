/**
 * Antigravity integration.
 *
 * Antigravity is Google's IDE.
 * The global MCP configuration is ~/.gemini/config/mcp_config.json.
 * The file stores servers under the mcpServers key.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { mergeMcpJson, removeMcpJson } from './utils.js';

const MCP_KEY_PATH = ['mcpServers', 'wigolo'];

function antigravityDir(): string {
  return join(homedir(), '.gemini', 'config');
}

function detect(): boolean {
  if (existsSync(antigravityDir())) return true;
  try {
    execSync('which antigravity', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

async function installMcp(cmd: { command: string; args: string[] }): Promise<void> {
  const dir = antigravityDir();
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'mcp_config.json');
  mergeMcpJson(configPath, { command: cmd.command, args: cmd.args }, MCP_KEY_PATH);
}

async function uninstall(): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const configPath = join(antigravityDir(), 'mcp_config.json');
  if (existsSync(configPath)) {
    removeMcpJson(configPath, MCP_KEY_PATH);
    removed.push('~/.gemini/config/mcp_config.json (wigolo entry)');
  }
  return { removed };
}

export const antigravityHandler = {
  id: 'antigravity' as const,
  displayName: 'Antigravity',
  supportsSkills: false,
  supportsCommands: false,
  detect,
  installMcp,
  // Antigravity has no instruction file in this integration.
  installInstructions: async () => { /* noop */ },
  uninstall,
};
