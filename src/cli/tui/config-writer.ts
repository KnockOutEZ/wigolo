import type { AgentId, DetectedAgent } from './agents.js';
import { dirname, join } from 'node:path';
import {
  removeJsonConfigEntry,
  writeJsonConfig,
  type WriteJsonConfigResult,
} from './config-writer-json.js';
import { writeTomlConfig, type WriteTomlConfigResult } from './config-writer-toml.js';
import { installViaClaudeCli, type InstallViaClaudeCliResult } from './config-writer-cli.js';

const SERVER_COMMAND = 'npx';
const SERVER_ARGS = ['-y', 'wigolo'];

interface JsonAgentSpec {
  keyPath: string[];
  entry?: Record<string, unknown>;
  extraEntryFields?: Record<string, unknown>;
}

const JSON_SPECS: Record<Exclude<AgentId, 'claude-code' | 'codex'>, JsonAgentSpec> = {
  cursor:       { keyPath: ['mcpServers', 'wigolo'] },
  vscode:       { keyPath: ['servers', 'wigolo'], extraEntryFields: { type: 'stdio' } },
  zed:          { keyPath: ['context_servers', 'wigolo'] },
  'gemini-cli': { keyPath: ['mcpServers', 'wigolo'] },
  windsurf:     { keyPath: ['mcpServers', 'wigolo'] },
  opencode:     {
    keyPath: ['mcp', 'wigolo'],
    entry: { type: 'local', command: [SERVER_COMMAND, ...SERVER_ARGS], enabled: true },
  },
  antigravity:  { keyPath: ['mcpServers', 'wigolo'] },
};

const CODEX_TABLE_PATH = ['mcp_servers', 'wigolo'];

export interface ConfigApplyResult {
  id: AgentId;
  displayName: string;
  ok: boolean;
  code: string;
  message?: string;
  configPath: string | null;
  alreadyInstalled?: boolean;
  dryRun?: boolean;
  backupPath?: string;
}

export interface ApplyConfigsOptions {
  dryRun?: boolean;
}

function buildEntry(extra?: Record<string, unknown>): Record<string, unknown> {
  return { command: SERVER_COMMAND, args: [...SERVER_ARGS], ...(extra ?? {}) };
}

type ResultBase = { id: AgentId; displayName: string; configPath: string | null };

async function applyOne(agent: DetectedAgent, opts: ApplyConfigsOptions): Promise<ConfigApplyResult> {
  const base: ResultBase = {
    id: agent.id,
    displayName: agent.displayName,
    configPath: agent.configPath,
  };

  if (agent.installType === 'cli-command') {
    const r = await installViaClaudeCli({ dryRun: opts.dryRun });
    return mapCliResult(base, r);
  }

  if (agent.installType === 'config-toml') {
    if (!agent.configPath) {
      return { ...base, ok: false, code: 'NO_CONFIG_PATH', message: 'no configPath for TOML agent' };
    }
    const r = await writeTomlConfig({
      path: agent.configPath,
      tablePath: CODEX_TABLE_PATH,
      entry: buildEntry(),
      dryRun: opts.dryRun,
    });
    return mapTomlResult(base, r);
  }

  if (!agent.configPath) {
    return { ...base, ok: false, code: 'NO_CONFIG_PATH', message: 'no configPath for JSON agent' };
  }
  const spec = JSON_SPECS[agent.id as keyof typeof JSON_SPECS];
  if (!spec) {
    return { ...base, ok: false, code: 'UNKNOWN_AGENT', message: `no JSON spec for ${agent.id}` };
  }
  const r = await writeJsonConfig({
    path: agent.configPath,
    keyPath: spec.keyPath,
    entry: spec.entry ?? buildEntry(spec.extraEntryFields),
    dryRun: opts.dryRun,
    allowJsonc: agent.id === 'opencode',
    requireBackup: agent.id === 'opencode',
  });
  if (agent.id === 'opencode' && r.ok) {
    const legacy = await removeJsonConfigEntry({
      path: join(dirname(agent.configPath), 'config.json'),
      keyPath: spec.keyPath,
      dryRun: opts.dryRun,
      allowJsonc: true,
      requireBackup: true,
    });
    if (!legacy.ok) {
      return mapJsonResult(base, {
        ...legacy,
        message: `legacy OpenCode config migration failed: ${legacy.message ?? legacy.code}`,
        backupPath: r.backupPath ?? legacy.backupPath,
      });
    }
  }
  return mapJsonResult(base, r);
}

function mapJsonResult(base: ResultBase, r: WriteJsonConfigResult): ConfigApplyResult {
  return {
    ...base,
    ok: r.ok,
    code: r.code,
    message: r.message,
    dryRun: r.dryRun,
    backupPath: r.backupPath,
  };
}

function mapTomlResult(base: ResultBase, r: WriteTomlConfigResult): ConfigApplyResult {
  return {
    ...base,
    ok: r.ok,
    code: r.code,
    message: r.message,
    dryRun: r.dryRun,
    backupPath: r.backupPath,
  };
}

function mapCliResult(base: ResultBase, r: InstallViaClaudeCliResult): ConfigApplyResult {
  return {
    ...base,
    ok: r.ok,
    code: r.code ?? (r.ok ? 'OK' : 'CLAUDE_FAILED'),
    message: r.message,
    alreadyInstalled: r.alreadyInstalled,
    dryRun: r.dryRun,
    // Surface the fallback path so the install summary can show it instead of
    // the (null) cli-command configPath when host `claude` was absent.
    configPath: r.fallbackPath ?? base.configPath,
  };
}

export async function applyConfigs(
  detected: DetectedAgent[],
  selected: AgentId[],
  opts: ApplyConfigsOptions = {},
): Promise<ConfigApplyResult[]> {
  const byId = new Map(detected.map((a) => [a.id, a]));
  const results: ConfigApplyResult[] = [];
  for (const id of selected) {
    const agent = byId.get(id);
    if (!agent) continue;
    const r = await applyOne(agent, opts);
    results.push(r);
  }
  return results;
}

export { JSON_SPECS, CODEX_TABLE_PATH };
export type { AgentId, DetectedAgent };
