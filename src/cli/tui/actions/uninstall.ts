/**
 * uninstall action — removes the wigolo data directory and calls each
 * detected agent handler's uninstall to unwire MCP configs.
 *
 * Contract:
 *   - Requires confirmed=true; without it returns ok=false with a
 *     confirmation-required error (TUI gates via dialog, headless via --yes).
 *   - Calls detectInstalledHandlers() from SP7's registry.
 *   - Each handler's uninstall() is called; failures are captured in
 *     agentResults but do NOT abort the data-dir removal.
 *   - Removing a non-existent data dir is safe (idempotent).
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve, parse as parsePath } from 'node:path';
import { homedir } from 'node:os';
import { detectInstalledHandlers } from '../../../cli/agents/registry.js';

export interface AgentUninstallResult {
  agentId: string;
  displayName: string;
  removed: string[];
  error?: string;
}

/**
 * Reject a data dir that would be dangerous to recursively delete. Guards
 * against a misconfigured WIGOLO_DATA_DIR (e.g. `/` or `$HOME`) turning the
 * uninstall into an `rm -rf` of a system path.
 *
 * Rejects:
 *   - the filesystem root (`/`, or a Windows drive root like `C:\`)
 *   - the user's home directory itself
 *   - well-known system roots
 * A normal data dir (`~/.wigolo`, or a deep tmp fixture dir under the OS temp
 * tree used in tests) passes.
 */
function isUnsafeDataDir(dataDir: string): boolean {
  const resolved = resolve(dataDir);
  const root = parsePath(resolved).root;

  // Filesystem root (POSIX `/` or Windows `C:\`).
  if (resolved === root || resolved === '/') return true;

  // The home directory itself (a parent of the real ~/.wigolo).
  if (resolved === resolve(homedir())) return true;

  // Obvious system roots that must never be wiped.
  const SYSTEM_ROOTS = [
    '/usr', '/bin', '/sbin', '/etc', '/var', '/lib', '/opt', '/boot',
    '/System', '/Library', '/Applications', '/private',
    'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
  ];
  for (const sys of SYSTEM_ROOTS) {
    if (resolved === sys) return true;
  }

  return false;
}

export interface UninstallOptions {
  dataDir: string;
  /** Must be true to proceed. TUI gates with confirmation dialog; headless --yes sets this. */
  confirmed: boolean;
}

export interface UninstallResult {
  ok: boolean;
  dataDirRemoved: boolean;
  agentResults: AgentUninstallResult[];
  error?: string;
}

export async function uninstall(opts: UninstallOptions): Promise<UninstallResult> {
  const { dataDir, confirmed } = opts;

  if (!confirmed) {
    return {
      ok: false,
      dataDirRemoved: false,
      agentResults: [],
      error: 'Uninstall requires confirmation. Pass confirmed: true or use --yes flag.',
    };
  }

  // Path-safety guard: refuse to recursively delete a dangerous root.
  if (isUnsafeDataDir(dataDir)) {
    return {
      ok: false,
      dataDirRemoved: false,
      agentResults: [],
      error: `Refusing to uninstall: data dir "${dataDir}" resolves to a system or home root and is unsafe to delete.`,
    };
  }

  const agentResults: AgentUninstallResult[] = [];

  // Call agent uninstallers first (so they can clean up before data dir is gone)
  const handlers = detectInstalledHandlers();
  for (const handler of handlers) {
    try {
      const res = await handler.uninstall();
      agentResults.push({
        agentId: handler.id,
        displayName: handler.displayName,
        removed: res.removed,
      });
    } catch (err) {
      agentResults.push({
        agentId: handler.id,
        displayName: handler.displayName,
        removed: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Remove data dir
  let dataDirRemoved = false;
  try {
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDirRemoved = true;
    } else {
      // Already absent — idempotent
      dataDirRemoved = true;
    }
  } catch (err) {
    return {
      ok: false,
      dataDirRemoved: false,
      agentResults,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ok: true,
    dataDirRemoved,
    agentResults,
  };
}
