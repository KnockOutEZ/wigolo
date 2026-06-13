/**
 * Registry of MCP agent targets the TUI propagates settings into.
 *
 * Each AgentTarget describes:
 *   - configPath: per-OS resolved JSON file the agent reads
 *   - serverPath: JSON path into that file pointing at the wigolo server entry
 *   - envPath:    JSON path within the server entry to the env block
 *   - detect():   is wigolo currently installed in this agent?
 *   - backupDir(): where propagation.ts writes pre-write backups
 *
 * Paths are aligned with the SP7 agent handlers in src/cli/agents/ so the
 * TUI mutates the same files the install flow created. Mismatching either
 * side would leave stale env blocks behind.
 */

import { readFile as nodeReadFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { vscodeUserDir } from '../../agents/vscode.js';

export type AgentId = 'claude-code' | 'vscode' | 'zed' | 'windsurf' | 'cursor';

export interface AgentTarget {
  id: AgentId;
  label: string;
  /** Absolute path to the agent's MCP/settings JSON file. */
  configPath: string;
  /** JSON path to the wigolo server entry, e.g. ['mcpServers', 'wigolo']. */
  serverPath: ReadonlyArray<string>;
  /** JSON path inside the server entry to its env block, e.g. ['mcpServers','wigolo','env']. */
  envPath: ReadonlyArray<string>;
  /** True when wigolo is currently registered in this agent's config. */
  detect(): Promise<boolean>;
  /** Directory the propagation pipeline writes per-agent backups into. */
  backupDir(): string;
}

export interface DefaultAgentTargetsOpts {
  /** Wigolo data dir (e.g. ~/.wigolo). Backups land at `<dataDir>/backups/`. */
  dataDir: string;
  /** Override for tests; defaults to os.homedir(). */
  home?: string;
  /** Override for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Override for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Returns true if the JSON file at `configPath` contains a value at the
 * specified `serverPath`. Returns false on parse errors or missing files.
 *
 * Fully async — uses fs.promises.readFile and treats ENOENT as a miss. The
 * 5-agent fan-out runs through Promise.all, so the per-agent probe must not
 * block the event loop.
 */
async function detectAtPath(configPath: string, serverPath: ReadonlyArray<string>): Promise<boolean> {
  let raw: string;
  try {
    raw = await nodeReadFile(configPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return false;
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  let cur: unknown = parsed;
  for (const key of serverPath) {
    if (!isObject(cur)) return false;
    cur = cur[key];
    if (cur === undefined) return false;
  }
  return cur !== undefined && cur !== null;
}

function resolveVscodeMcpPath(home: string, plat: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const override = env.WIGOLO_VSCODE_MCP_PATH;
  if (override) return override;
  void plat; // platform branch reserved for future Code/User layout
  return join(vscodeUserDir(home), 'mcp.json');
}

export function defaultAgentTargets(opts: DefaultAgentTargetsOpts): AgentTarget[] {
  const home = opts.home ?? homedir();
  const plat: NodeJS.Platform = opts.platform ?? platform();
  const env = opts.env ?? process.env;
  const backupDir = join(opts.dataDir, 'backups');

  const claudeCodePath = join(home, '.claude.json');
  const claudeCodeServer: ReadonlyArray<string> = ['mcpServers', 'wigolo'];

  const vscodePath = resolveVscodeMcpPath(home, plat, env);
  const vscodeServer: ReadonlyArray<string> = ['servers', 'wigolo'];

  const zedPath = join(home, '.config', 'zed', 'settings.json');
  const zedServer: ReadonlyArray<string> = ['context_servers', 'wigolo'];

  const windsurfPath = join(home, '.codeium', 'windsurf', 'mcp_config.json');
  const windsurfServer: ReadonlyArray<string> = ['mcpServers', 'wigolo'];

  const cursorPath = join(home, '.cursor', 'mcp.json');
  const cursorServer: ReadonlyArray<string> = ['mcpServers', 'wigolo'];

  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      configPath: claudeCodePath,
      serverPath: claudeCodeServer,
      envPath: [...claudeCodeServer, 'env'],
      detect: () => detectAtPath(claudeCodePath, claudeCodeServer),
      backupDir: () => backupDir,
    },
    {
      id: 'vscode',
      label: 'VS Code (Copilot)',
      configPath: vscodePath,
      serverPath: vscodeServer,
      envPath: [...vscodeServer, 'env'],
      detect: () => detectAtPath(vscodePath, vscodeServer),
      backupDir: () => backupDir,
    },
    {
      id: 'zed',
      label: 'Zed',
      configPath: zedPath,
      serverPath: zedServer,
      envPath: [...zedServer, 'env'],
      detect: () => detectAtPath(zedPath, zedServer),
      backupDir: () => backupDir,
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      configPath: windsurfPath,
      serverPath: windsurfServer,
      envPath: [...windsurfServer, 'env'],
      detect: () => detectAtPath(windsurfPath, windsurfServer),
      backupDir: () => backupDir,
    },
    {
      id: 'cursor',
      label: 'Cursor',
      configPath: cursorPath,
      serverPath: cursorServer,
      envPath: [...cursorServer, 'env'],
      detect: () => detectAtPath(cursorPath, cursorServer),
      backupDir: () => backupDir,
    },
  ];
}
