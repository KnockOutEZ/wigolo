/**
 * Antigravity integration.
 *
 * Antigravity is Anthropic's IDE (VS Code-derived), storing config in ~/.antigravity/.
 * MCP config format mirrors VS Code's mcp.json (mcpServers key).
 *
 * TODO: When Antigravity's official MCP config docs are published, verify the
 * exact config path and key structure.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { mergeMcpJson, removeMcpJson } from './utils.js';

const MCP_KEY_PATH = ['mcpServers', 'wigolo'];

function antigravityDir(): string {
  return join(homedir(), '.antigravity');
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
  const configPath = join(dir, 'mcp.json');
  mergeMcpJson(configPath, { command: cmd.command, args: cmd.args }, MCP_KEY_PATH);
}

async function uninstall(): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const configPath = join(antigravityDir(), 'mcp.json');
  if (existsSync(configPath)) {
    removeMcpJson(configPath, MCP_KEY_PATH);
    removed.push('~/.antigravity/mcp.json (wigolo entry)');
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
  // No instructions layer for antigravity (config format unclear, MCP only)
  installInstructions: async () => { /* noop */ },
  uninstall,
};
