import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';

export interface ConnectedAgent {
  id: string;
  displayName: string;
  configured: boolean;
  path: string;
}

interface AgentSpec {
  id: string;
  displayName: string;
  format: 'json' | 'toml' | 'cli';
  relPath: string;
  keyPath: readonly string[];
}

const SPECS: readonly AgentSpec[] = [
  { id: 'claude-code', displayName: 'Claude Code',    format: 'cli',  relPath: '',                                  keyPath: [] },
  { id: 'cursor',      displayName: 'Cursor',         format: 'json', relPath: '.cursor/mcp.json',                  keyPath: ['mcpServers', 'wigolo'] },
  { id: 'vscode',      displayName: 'VS Code',        format: 'json', relPath: '.vscode/mcp.json',                  keyPath: ['servers', 'wigolo'] },
  { id: 'zed',         displayName: 'Zed',            format: 'json', relPath: '.config/zed/settings.json',         keyPath: ['context_servers', 'wigolo'] },
  { id: 'gemini-cli',  displayName: 'Gemini CLI',     format: 'json', relPath: '.gemini/settings.json',             keyPath: ['mcpServers', 'wigolo'] },
  { id: 'windsurf',    displayName: 'Windsurf',       format: 'json', relPath: '.codeium/windsurf/mcp_config.json', keyPath: ['mcpServers', 'wigolo'] },
  { id: 'opencode',    displayName: 'OpenCode',       format: 'json', relPath: '.config/opencode/config.json',      keyPath: ['mcp', 'wigolo'] },
  { id: 'codex',       displayName: 'Codex',          format: 'toml', relPath: '.codex/config.toml',                keyPath: ['mcp_servers', 'wigolo'] },
];

export interface ReadConnectedAgentsOptions {
  home?: string;
}

export function readConnectedAgents(opts: ReadConnectedAgentsOptions = {}): ConnectedAgent[] {
  const home = opts.home ?? homedir();
  const out: ConnectedAgent[] = [];

  for (const spec of SPECS) {
    if (spec.format === 'cli') {
      out.push({ id: spec.id, displayName: spec.displayName, configured: false, path: '(use `claude mcp list`)' });
      continue;
    }

    const abs = join(home, spec.relPath);
    if (!existsSync(abs)) {
      out.push({ id: spec.id, displayName: spec.displayName, configured: false, path: abs });
      continue;
    }

    let parsed: unknown;
    try {
      const raw = readFileSync(abs, 'utf-8');
      parsed = spec.format === 'toml' ? TOML.parse(raw) : JSON.parse(raw);
    } catch {
      out.push({ id: spec.id, displayName: spec.displayName, configured: false, path: abs });
      continue;
    }

    const configured = hasKeyPath(parsed, spec.keyPath);
    out.push({ id: spec.id, displayName: spec.displayName, configured, path: abs });
  }

  return out;
}

function hasKeyPath(node: unknown, keyPath: readonly string[]): boolean {
  let cursor: unknown = node;
  for (const key of keyPath) {
    if (typeof cursor !== 'object' || cursor === null) return false;
    if (!(key in (cursor as Record<string, unknown>))) return false;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor !== undefined && cursor !== null;
}
