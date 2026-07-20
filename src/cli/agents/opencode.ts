/** OpenCode integration: local MCP config with no separate instructions layer. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { binaryInPath } from '../tui/detect-helpers.js';
import { removeJsonConfigEntry, writeJsonConfig } from '../tui/config-writer-json.js';

const MCP_KEY_PATH = ['mcp', 'wigolo'] as const;
const MCP_ENTRY_LABEL = '~/.config/opencode/opencode.json (wigolo mcp entry)';
const LEGACY_ENTRY_LABEL = '~/.config/opencode/config.json (legacy wigolo mcp entry)';

interface SyncOpencodeConfigResult {
  ok: boolean;
  code: string;
  message?: string;
  removed: string[];
  backupPath?: string;
  dryRun?: boolean;
}

interface OpencodeCommand {
  command: string;
  args: string[];
}

export interface SyncOpencodeConfigOptions {
  command?: OpencodeCommand;
  dryRun?: boolean;
  configPath?: string;
  legacyConfigPath?: string;
}

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
  return binaryInPath('opencode') !== null;
}

function buildEntry(command: OpencodeCommand): Record<string, unknown> {
  return { type: 'local', command: [command.command, ...command.args], enabled: true };
}

export async function syncOpencodeConfig(
  options: SyncOpencodeConfigOptions = {},
): Promise<SyncOpencodeConfigResult> {
  const { command, dryRun } = options;
  const removed: string[] = [];
  const targetConfigPath = options.configPath ?? configPath();
  const targetLegacyConfigPath = options.legacyConfigPath ?? legacyConfigPath();

  if (command) {
    const wrote = await writeJsonConfig({
      path: targetConfigPath,
      keyPath: [...MCP_KEY_PATH],
      entry: buildEntry(command),
      allowJsonc: true,
      requireBackup: true,
      dryRun,
    });
    if (!wrote.ok) {
      return {
        ok: false,
        code: wrote.code,
        message: `OpenCode config write failed: ${wrote.message ?? wrote.code}`,
        backupPath: wrote.backupPath,
        removed,
        dryRun,
      };
    }

    const migrated = await removeJsonConfigEntry({
      path: targetLegacyConfigPath,
      keyPath: [...MCP_KEY_PATH],
      dryRun,
      allowJsonc: true,
      requireBackup: true,
    });
    if (!migrated.ok) {
      return {
        ok: false,
        code: migrated.code,
        message: `legacy OpenCode config migration failed: ${migrated.message ?? migrated.code}`,
        backupPath: wrote.backupPath ?? migrated.backupPath,
        removed,
        dryRun: migrated.dryRun,
      };
    }
    if (migrated.removed) {
      removed.push(LEGACY_ENTRY_LABEL);
    }

    return {
      ok: true,
      code: 'OK',
      removed,
      backupPath: wrote.backupPath ?? migrated.backupPath,
      dryRun: wrote.dryRun ?? migrated.dryRun,
    };
  }

  const current = await removeJsonConfigEntry({
    path: targetConfigPath,
    keyPath: [...MCP_KEY_PATH],
    dryRun,
    allowJsonc: true,
    requireBackup: true,
  });
  if (!current.ok) {
    return {
      ok: false,
      code: current.code,
      message: `OpenCode config cleanup failed: ${current.message ?? current.code}`,
      backupPath: current.backupPath,
      removed,
      dryRun: current.dryRun,
    };
  }
  if (current.removed) {
    removed.push(MCP_ENTRY_LABEL);
  }

  const migrated = await removeJsonConfigEntry({
    path: targetLegacyConfigPath,
    keyPath: [...MCP_KEY_PATH],
    dryRun,
    allowJsonc: true,
    requireBackup: true,
  });
  if (!migrated.ok) {
    return {
      ok: false,
      code: migrated.code,
      message: `legacy OpenCode config cleanup failed: ${migrated.message ?? migrated.code}`,
      backupPath: current.backupPath ?? migrated.backupPath,
      removed,
      dryRun: migrated.dryRun,
    };
  }
  if (migrated.removed) {
    removed.push(LEGACY_ENTRY_LABEL);
  }

  return {
    ok: true,
    code: 'OK',
    removed,
    backupPath: current.backupPath ?? migrated.backupPath,
    dryRun: current.dryRun ?? migrated.dryRun,
  };
}

async function installMcp(cmd: { command: string; args: string[] }): Promise<void> {
  const result = await syncOpencodeConfig({ command: { command: cmd.command, args: cmd.args } });
  if (!result.ok) {
    throw new Error(result.message ?? 'OpenCode install failed');
  }
}

async function uninstall(): Promise<{ removed: string[] }> {
  const result = await syncOpencodeConfig();
  if (!result.ok) {
    throw new Error(result.message ?? 'OpenCode cleanup failed');
  }
  return { removed: result.removed };
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
