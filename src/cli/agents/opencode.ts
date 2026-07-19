/** OpenCode integration: local MCP config with no separate instructions layer. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { removeJsonConfigEntry, writeJsonConfig } from '../tui/config-writer-json.js';

const MCP_KEY_PATH = ['mcp', 'wigolo'];

function opencodeDir(): string {
  return join(homedir(), '.config', 'opencode');
}

function configPath(): string {
  return join(opencodeDir(), 'opencode.json');
}

function legacyConfigPath(): string {
  return join(opencodeDir(), 'config.json');
}

function detect(): boolean {
  if (existsSync(opencodeDir())) return true;
  try {
    execSync('which opencode', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

async function installMcp(cmd: { command: string; args: string[] }): Promise<void> {
  const written = await writeJsonConfig({
    path: configPath(),
    keyPath: MCP_KEY_PATH,
    entry: { type: 'local', command: [cmd.command, ...cmd.args], enabled: true },
    allowJsonc: true,
    requireBackup: true,
  });
  if (!written.ok) throw new Error(`OpenCode config write failed: ${written.message ?? written.code}`);

  const migrated = await removeJsonConfigEntry({
    path: legacyConfigPath(),
    keyPath: MCP_KEY_PATH,
    allowJsonc: true,
    requireBackup: true,
  });
  if (!migrated.ok) {
    throw new Error(`legacy OpenCode config migration failed: ${migrated.message ?? migrated.code}`);
  }
}

async function uninstall(): Promise<{ removed: string[] }> {
  const removed: string[] = [];

  const current = await removeJsonConfigEntry({
    path: configPath(),
    keyPath: MCP_KEY_PATH,
    allowJsonc: true,
    requireBackup: true,
  });
  if (!current.ok) throw new Error(`OpenCode config cleanup failed: ${current.message ?? current.code}`);
  if (current.removed) {
    removed.push('~/.config/opencode/opencode.json (wigolo mcp entry)');
  }

  const legacy = await removeJsonConfigEntry({
    path: legacyConfigPath(),
    keyPath: MCP_KEY_PATH,
    allowJsonc: true,
    requireBackup: true,
  });
  if (!legacy.ok) throw new Error(`legacy OpenCode config cleanup failed: ${legacy.message ?? legacy.code}`);
  if (legacy.removed) {
    removed.push('~/.config/opencode/config.json (legacy wigolo mcp entry)');
  }

  return { removed };
}

export const opencodeHandler = {
  id: 'opencode' as const,
  displayName: 'OpenCode',
  supportsSkills: false,
  supportsCommands: false,
  detect,
  installMcp,
  installInstructions: async () => { /* OpenCode receives guidance through MCP server instructions. */ },
  uninstall,
};
