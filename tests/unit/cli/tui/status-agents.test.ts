import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConnectedAgents } from '../../../../src/cli/tui/status-agents.js';

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
      '[mcp_servers.wigolo]\ncommand = "npx"\nargs = ["-y", "@staticn0va/wigolo"]\n',
    );

    const result = readConnectedAgents({ home: tmpHome });
    const codex = result.find(a => a.id === 'codex');
    expect(codex?.configured).toBe(true);
  });

  it('reports an agent as configured=false when the config file is corrupt', () => {
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'mcp.json'), '{{{not-json');

    const result = readConnectedAgents({ home: tmpHome });
    const cursor = result.find(a => a.id === 'cursor');
    expect(cursor?.configured).toBe(false);
  });
});
