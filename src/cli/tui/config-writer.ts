import type { AgentId, DetectedAgent } from './agents.js';
import { writeJsonConfig, type WriteJsonConfigResult } from './config-writer-json.js';
import { writeTomlConfig, type WriteTomlConfigResult } from './config-writer-toml.js';
import { installViaClaudeCli, type InstallViaClaudeCliResult } from './config-writer-cli.js';

const SERVER_COMMAND = 'npx';
const SERVER_ARGS = ['-y', '@staticn0va/wigolo'];

interface JsonAgentSpec {
  keyPath: string[];
  extraEntryFields?: Record<string, unknown>;
}

const JSON_SPECS: Record<Exclude<AgentId, 'claude-code' | 'codex'>, JsonAgentSpec> = {
  cursor:       { keyPath: ['mcpServers', 'wigolo'] },
  vscode:       { keyPath: ['servers', 'wigolo'], extraEntryFields: { type: 'stdio' } },
  zed:          { keyPath: ['context_servers', 'wigolo'] },
  'gemini-cli': { keyPath: ['mcpServers', 'wigolo'] },
  windsurf:     { keyPath: ['mcpServers', 'wigolo'] },
  opencode:     { keyPath: ['mcp', 'wigolo'], extraEntryFields: { type: 'local' } },
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
    entry: buildEntry(spec.extraEntryFields),
    dryRun: opts.dryRun,
  });
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
