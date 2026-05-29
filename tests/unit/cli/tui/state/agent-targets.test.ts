import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { defaultAgentTargets } from '../../../../../src/cli/tui/state/agent-targets.js';

describe('defaultAgentTargets', () => {
  const dataDir = '/tmp/wigolo-test-fixture';
  const targets = defaultAgentTargets({ dataDir });

  it('registers all five supported agents', () => {
    const ids = targets.map((t) => t.id).sort();
    expect(ids).toEqual(
      ['claude-code', 'cursor', 'vscode', 'windsurf', 'zed'].sort(),
    );
  });

  it('every target has a non-empty configPath, label, serverPath, envPath', () => {
    for (const t of targets) {
      expect(t.configPath, `target ${t.id} missing configPath`).toBeTruthy();
      expect(t.label, `target ${t.id} missing label`).toBeTruthy();
      expect(t.serverPath.length, `target ${t.id} empty serverPath`).toBeGreaterThan(0);
      expect(t.envPath.length, `target ${t.id} empty envPath`).toBeGreaterThan(0);
    }
  });

  it('envPath always ends in "env"', () => {
    for (const t of targets) {
      expect(t.envPath[t.envPath.length - 1], `target ${t.id}`).toBe('env');
    }
  });

  it('backupDir resolves inside the supplied dataDir', () => {
    for (const t of targets) {
      expect(t.backupDir().startsWith(join(dataDir, 'backups'))).toBe(true);
    }
  });

  it('claude-code points at ~/.claude.json with mcpServers/wigolo path', () => {
    const cc = targets.find((t) => t.id === 'claude-code');
    expect(cc).toBeDefined();
    expect(cc!.configPath.endsWith('.claude.json')).toBe(true);
    expect(cc!.serverPath).toEqual(['mcpServers', 'wigolo']);
    expect(cc!.envPath).toEqual(['mcpServers', 'wigolo', 'env']);
  });

  it('cursor points at ~/.cursor/mcp.json with mcpServers/wigolo path', () => {
    const c = targets.find((t) => t.id === 'cursor');
    expect(c).toBeDefined();
    expect(c!.configPath.endsWith(join('.cursor', 'mcp.json'))).toBe(true);
    expect(c!.serverPath).toEqual(['mcpServers', 'wigolo']);
  });

  it('windsurf points at .codeium/windsurf/mcp_config.json', () => {
    const w = targets.find((t) => t.id === 'windsurf');
    expect(w).toBeDefined();
    expect(w!.configPath.endsWith(join('.codeium', 'windsurf', 'mcp_config.json'))).toBe(true);
  });

  it('zed points at .config/zed/settings.json with context_servers path', () => {
    const z = targets.find((t) => t.id === 'zed');
    expect(z).toBeDefined();
    expect(z!.configPath.endsWith(join('.config', 'zed', 'settings.json'))).toBe(true);
    expect(z!.serverPath).toEqual(['context_servers', 'wigolo']);
  });

  it('vscode points at servers/wigolo path', () => {
    const v = targets.find((t) => t.id === 'vscode');
    expect(v).toBeDefined();
    expect(v!.serverPath).toEqual(['servers', 'wigolo']);
    expect(v!.envPath).toEqual(['servers', 'wigolo', 'env']);
  });

  it('detect is callable and returns a boolean', async () => {
    for (const t of targets) {
      const result = await t.detect();
      expect(typeof result).toBe('boolean');
    }
  });
});
