/**
 * Antigravity integration.
 *
 * Antigravity is Google's IDE.
 * The global MCP configuration is ~/.gemini/config/mcp_config.json.
 * The file stores servers under the mcpServers key.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { mergeMcpJson, removeMcpJson } from './utils.js';

const MCP_KEY_PATH = ['mcpServers', 'wigolo'];

export function antigravityDataDir(home: string = homedir()): string {
  return join(home, '.gemini', 'antigravity');
}

export function antigravityMcpConfigPath(home: string = homedir()): string {
  return join(home, '.gemini', 'config', 'mcp_config.json');
}

function binaryExists(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function detect(): boolean {
  return existsSync(antigravityDataDir()) ||
    binaryExists('agy') ||
    binaryExists('antigravity');
}

async function installMcp(cmd: { command: string; args: string[] }): Promise<void> {
  const configPath = antigravityMcpConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  mergeMcpJson(configPath, { command: cmd.command, args: cmd.args }, MCP_KEY_PATH);
}

async function uninstall(): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const configPath = antigravityMcpConfigPath();
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
