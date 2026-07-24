import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConnectedAgents } from '../../../../src/cli/tui/status-agents.js';
import { vscodeUserDir } from '../../../../src/cli/agents/vscode.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'wigolo-status-agents-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('readConnectedAgents', () => {
  it('returns every agent with configured=false when no files exist', () => {
    const result = readConnectedAgents({ home: tmpHome });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(a => a.configured === false)).toBe(true);
  });

  it('reports cursor as configured when its JSON file contains mcpServers.wigolo', () => {
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { wigolo: { command: 'npx' } } }),
    );

    const result = readConnectedAgents({ home: tmpHome });
    const cursor = result.find(a => a.id === 'cursor');
    expect(cursor?.configured).toBe(true);
    expect(cursor?.path).toBe(join(cursorDir, 'mcp.json'));
  });

  it('reports zed as configured when settings.json contains context_servers.wigolo', () => {
    const zedDir = join(tmpHome, '.config', 'zed');
    mkdirSync(zedDir, { recursive: true });
    writeFileSync(
      join(zedDir, 'settings.json'),
      JSON.stringify({ context_servers: { wigolo: { command: 'npx' } } }),
    );

    const result = readConnectedAgents({ home: tmpHome });
    const zed = result.find(a => a.id === 'zed');
    expect(zed?.configured).toBe(true);
  });

  it('reports codex as configured when config.toml contains mcp_servers.wigolo', () => {
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, 'config.toml'),
      '[mcp_servers.wigolo]\ncommand = "npx"\nargs = ["-y", "wigolo"]\n',
    );

    const result = readConnectedAgents({ home: tmpHome });
    const codex = result.find(a => a.id === 'codex');
    expect(codex?.configured).toBe(true);
  });

  it('reports opencode as configured from its global opencode.json file', () => {
    const opencodeDir = join(tmpHome, '.config', 'opencode');
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify({
        mcp: {
          wigolo: {
            type: 'local',
            command: ['npx', '-y', 'wigolo'],
            enabled: true,
          },
        },
      }),
    );

    const result = readConnectedAgents({ home: tmpHome });
    const opencode = result.find(a => a.id === 'opencode');
    expect(opencode?.configured).toBe(true);
    expect(opencode?.path).toBe(join(opencodeDir, 'opencode.json'));
  });

  it('reports opencode as configured when opencode.json uses JSONC syntax', () => {
    const opencodeDir = join(tmpHome, '.config', 'opencode');
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      join(opencodeDir, 'opencode.json'),
      `{
        // OpenCode accepts comments and trailing commas.
        "mcp": {
          "wigolo": {
            "type": "local",
            "command": ["npx", "-y", "wigolo"],
            "enabled": true,
          },
        },
      }`,
    );

    const result = readConnectedAgents({ home: tmpHome });
    expect(result.find(a => a.id === 'opencode')?.configured).toBe(true);
  });

  it('reports a BOM-prefixed OpenCode JSONC config as connected', () => {
    const opencodeDir = join(tmpHome, '.config', 'opencode');
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      join(opencodeDir, 'opencode.json'),
      '\ufeff{"mcp":{"wigolo":{"type":"local","command":["npx","-y","wigolo"],"enabled":true}}}\n',
    );

    const result = readConnectedAgents({ home: tmpHome });
    expect(result.find(a => a.id === 'opencode')?.configured).toBe(true);
  });

  it('does not report a disabled OpenCode MCP entry as connected', () => {
    const opencodeDir = join(tmpHome, '.config', 'opencode');
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify({
        mcp: {
          wigolo: {
            type: 'local',
            command: ['npx', '-y', 'wigolo'],
            enabled: false,
          },
        },
      }),
    );

    const result = readConnectedAgents({ home: tmpHome });
    expect(result.find(a => a.id === 'opencode')?.configured).toBe(false);
  });

  it.each(['false', 0, null])('rejects a non-boolean OpenCode enabled value: %j', (enabled) => {
    const opencodeDir = join(tmpHome, '.config', 'opencode');
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify({
        mcp: {
          wigolo: { type: 'local', command: ['npx', '-y', 'wigolo'], enabled },
        },
      }),
    );

    const result = readConnectedAgents({ home: tmpHome });
    expect(result.find(a => a.id === 'opencode')?.configured).toBe(false);
  });

  it('does not report the legacy OpenCode command shape as connected', () => {
    const opencodeDir = join(tmpHome, '.config', 'opencode');
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify({
        mcp: {
          wigolo: { type: 'local', command: 'npx', args: ['-y', 'wigolo'] },
        },
      }),
    );

    const result = readConnectedAgents({ home: tmpHome });
    expect(result.find(a => a.id === 'opencode')?.configured).toBe(false);
  });

  it('reports an agent as configured=false when the config file is corrupt', () => {
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'mcp.json'), '{{{not-json');

    const result = readConnectedAgents({ home: tmpHome });
    const cursor = result.find(a => a.id === 'cursor');
    expect(cursor?.configured).toBe(false);
  });

  it('reports vscode as configured from the per-user Code/User dir, not ~/.vscode', () => {
    // VS Code is detected at vscodeUserDir(home)/mcp.json (servers.wigolo), the
    // same per-user path the installer writes — clear XDG/APPDATA so the dir
    // resolves under the temp home on every platform.
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const savedAppData = process.env.APPDATA;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.APPDATA;
    try {
      const vscodeDir = vscodeUserDir(tmpHome);
      mkdirSync(vscodeDir, { recursive: true });
      writeFileSync(
        join(vscodeDir, 'mcp.json'),
        JSON.stringify({ servers: { wigolo: { command: 'npx' } } }),
      );

      const result = readConnectedAgents({ home: tmpHome });
      const vscode = result.find(a => a.id === 'vscode');
      expect(vscode?.configured).toBe(true);
      expect(vscode?.path).toBe(join(vscodeDir, 'mcp.json'));
    } finally {
      if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
      if (savedAppData !== undefined) process.env.APPDATA = savedAppData;
    }
  });
});
