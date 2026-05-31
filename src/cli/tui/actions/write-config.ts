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
import { writePersistedConfig, readPersistedConfig, defaultConfigPath } from '../../../persisted-config.js';

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
 * Convert a dotted key path ("llm.apiKey") into a nested object
 * ({ llm: { apiKey: value } }). Single-segment paths produce { key: value }.
 * An empty path returns {}.
 */
export function unflattenDottedKey(path: string, value: unknown): Record<string, unknown> {
  const segments = path.split('.');
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) return {};
  const result: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = result;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
    cursor[seg] = {};
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
  return result;
}

/**
 * Deep-set a leaf value on an object at the given dotted path.
 * Mutates and returns `obj`. Intermediate objects are created if absent or if
 * a non-object value occupies a node on the path.
 */
function deepSet(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segments = path.split('.');
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) return obj;
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] as string;
    const child = cursor[seg];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
  return obj;
}

/**
 * Persist a single settings key to ~/.wigolo/config.json (or WIGOLO_CONFIG_PATH).
 * Read-modify-write: reads the current file, deep-sets the leaf at `path`, then
 * writes back the full merged settings so sibling keys under the same top-level
 * namespace are preserved.
 * Called by settings-store.commitOne on every blur event.
 */
export async function persistKey(path: string, value: unknown): Promise<void> {
  const configPath = defaultConfigPath();
  const current = readPersistedConfig(configPath);
  const settings = deepSet({ ...current.settings }, path, value);
  return await Promise.resolve(writePersistedConfig(configPath, { settings }));
}
