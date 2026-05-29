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

import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

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
 */
async function detectAtPath(configPath: string, serverPath: ReadonlyArray<string>): Promise<boolean> {
  if (!existsSync(configPath)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
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
  // SP7's vscode handler writes to ~/.vscode/mcp.json. Keep parity so the TUI
  // mutates the same file that install created. If users use the per-user
  // Code/User/mcp.json instead, they can override via WIGOLO_VSCODE_MCP_PATH.
  const override = env.WIGOLO_VSCODE_MCP_PATH;
  if (override) return override;
  // Honour per-OS Code/User/mcp.json as documented in the plan when present,
  // otherwise fall back to SP7's ~/.vscode/mcp.json. We check existence in
  // detect() — for the configPath we prefer the SP7 path because that's where
  // install lands, but allow the platform-canonical path as override.
  void plat; // platform branch reserved for future Code/User layout
  return join(home, '.vscode', 'mcp.json');
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
