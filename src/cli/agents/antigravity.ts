/**
 * Antigravity integration.
 *
 * Antigravity is Google's IDE.
 * The global MCP configuration is ~/.gemini/config/mcp_config.json.
 * The file stores servers under the mcpServers key.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { binaryInPath } from '../tui/detect-helpers.js';
import { mergeMcpJson, removeMcpJson } from './utils.js';

const MCP_KEY_PATH = ['mcpServers', 'wigolo'];

export function antigravityDataDir(home: string = homedir()): string {
  return join(home, '.gemini', 'antigravity');
}

export function antigravityMcpConfigPath(home: string = homedir()): string {
  return join(home, '.gemini', 'config', 'mcp_config.json');
}

function detect(): boolean {
  return existsSync(antigravityDataDir()) ||
    binaryInPath('agy') !== null ||
    binaryInPath('antigravity') !== null;
}

/** The path older wigolo versions wrote to. Antigravity does not read it. */
function legacyMcpConfigPath(home: string = homedir()): string {
  return join(home, '.antigravity', 'mcp.json');
}

/** Drop a wigolo entry from the legacy file. Returns true when one was removed. */
function removeLegacyEntry(): boolean {
  const legacyPath = legacyMcpConfigPath();
  if (!existsSync(legacyPath)) return false;
  try {
    const root = JSON.parse(readFileSync(legacyPath, 'utf-8')) as { mcpServers?: Record<string, unknown> };
    if (!root?.mcpServers || !('wigolo' in root.mcpServers)) return false;
  } catch {
    return false;
  }
  removeMcpJson(legacyPath, MCP_KEY_PATH);
  return true;
}

async function installMcp(cmd: { command: string; args: string[] }): Promise<void> {
  const configPath = antigravityMcpConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  mergeMcpJson(configPath, { command: cmd.command, args: cmd.args }, MCP_KEY_PATH);
  removeLegacyEntry();
}

async function uninstall(): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const configPath = antigravityMcpConfigPath();
  if (existsSync(configPath)) {
    removeMcpJson(configPath, MCP_KEY_PATH);
    removed.push('~/.gemini/config/mcp_config.json (wigolo entry)');
  }
  if (removeLegacyEntry()) removed.push('~/.antigravity/mcp.json (old wigolo entry)');
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
