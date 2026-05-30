/**
 * write-config action — writes MCP config entries for selected agents and
 * returns a structured per-item result. Used by both TUI and headless CLI.
 *
 * This is the commit-with-per-item-result action that satisfies the
 * "no silent config-write failures" requirement.
 */
import { applyConfigs, type ConfigApplyResult } from '../config-writer.js';
import type { AgentId, DetectedAgent } from '../agents.js';
import type { WriteResult } from './types.js';
import { writePersistedConfig, defaultConfigPath } from '../../../persisted-config.js';

export interface WriteMcpConfigOptions {
  dryRun?: boolean;
}

export interface WriteMcpConfigResult {
  results: WriteResult[];
  anyFailed: boolean;
}

function toWriteResult(r: ConfigApplyResult): WriteResult {
  if (r.ok) {
    return {
      id: r.id,
      label: r.displayName,
      status: r.alreadyInstalled ? 'already_installed' : 'ok',
      path: r.configPath ?? undefined,
    };
  }
  return {
    id: r.id,
    label: r.displayName,
    status: 'failed',
    path: r.configPath ?? undefined,
    error: r.message ?? r.code,
  };
}

export async function writeMcpConfig(
  detected: DetectedAgent[],
  selected: AgentId[],
  opts: WriteMcpConfigOptions = {},
): Promise<WriteMcpConfigResult> {
  const raw = await applyConfigs(detected, selected, { dryRun: opts.dryRun });
  const results = raw.map(toWriteResult);
  const anyFailed = results.some((r) => r.status === 'failed');
  return { results, anyFailed };
}

export type { WriteResult };

/**
 * Persist a single settings key to ~/.wigolo/config.json (or WIGOLO_CONFIG_PATH).
 * Read-modify-write via writePersistedConfig so other settings are preserved.
 * Called by settings-store.commitOne on every blur event.
 */
export async function persistKey(path: string, value: unknown): Promise<void> {
  const configPath = defaultConfigPath();
  return await Promise.resolve(writePersistedConfig(configPath, { settings: { [path]: value } }));
}
