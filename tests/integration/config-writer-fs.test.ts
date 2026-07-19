import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { applyConfigs } from '../../src/cli/tui/config-writer.js';
import type { DetectedAgent } from '../../src/cli/tui/agents.js';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wigolo-d4-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('applyConfigs round-trip', () => {
  it('writes Cursor config and round-trips correctly', async () => {
    const agents: DetectedAgent[] = [{
      id: 'cursor', displayName: 'Cursor', detected: true,
      configPath: join(dir, 'cursor', 'mcp.json'),
      installType: 'config-file',
    }];
    const results = await applyConfigs(agents, ['cursor']);
    expect(results[0].ok).toBe(true);
    const content = JSON.parse(readFileSync(join(dir, 'cursor', 'mcp.json'), 'utf-8'));
    expect(content.mcpServers.wigolo).toEqual({ command: 'npx', args: ['-y', 'wigolo'] });
  });

  it('merges into existing Zed settings without losing other keys', async () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({
      theme: 'One Dark',
      buffer_font_size: 14,
      context_servers: {
        existing: { command: 'foo', args: ['bar'] },
      },
    }, null, 2));
    const agents: DetectedAgent[] = [{
      id: 'zed', displayName: 'Zed', detected: true, configPath: path, installType: 'config-file',
    }];
    const results = await applyConfigs(agents, ['zed']);
    expect(results[0].ok).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.theme).toBe('One Dark');
    expect(content.buffer_font_size).toBe(14);
    expect(content.context_servers.existing).toEqual({ command: 'foo', args: ['bar'] });
    expect(content.context_servers.wigolo).toEqual({ command: 'npx', args: ['-y', 'wigolo'] });
  });

  it('writes Codex TOML correctly', async () => {
    const path = join(dir, 'codex', 'config.toml');
    const agents: DetectedAgent[] = [{
      id: 'codex', displayName: 'Codex (OpenAI CLI)', detected: false,
      configPath: path, installType: 'config-toml',
    }];
    const results = await applyConfigs(agents, ['codex']);
    expect(results[0].ok).toBe(true);
    const parsed = parseToml(readFileSync(path, 'utf-8')) as any;
    expect(parsed.mcp_servers.wigolo.command).toBe('npx');
    expect(parsed.mcp_servers.wigolo.args).toEqual(['-y', 'wigolo']);
  });

  it('writes VS Code config with type:stdio', async () => {
    const path = join(dir, 'vscode', 'mcp.json');
    const agents: DetectedAgent[] = [{
      id: 'vscode', displayName: 'VS Code (Copilot)', detected: false,
      configPath: path, installType: 'config-file',
    }];
    await applyConfigs(agents, ['vscode']);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.servers.wigolo.type).toBe('stdio');
  });

  it('writes OpenCode opencode.json and removes the legacy config.json entry', async () => {
    const configDir = join(dir, 'opencode');
    const currentPath = join(configDir, 'opencode.json');
    const legacyPath = join(configDir, 'config.json');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(legacyPath, `{
      // valid OpenCode JSONC
      "theme": "system",
      "mcp": {
        "other": { "type": "remote", "url": "https://example.com/mcp" },
        "wigolo": { "type": "local", "command": "npx", "args": ["-y", "wigolo"] },
      },
    }`);
    const agents: DetectedAgent[] = [{
      id: 'opencode', displayName: 'OpenCode', detected: true,
      configPath: currentPath, installType: 'config-file',
    }];

    const results = await applyConfigs(agents, ['opencode']);

    expect(results[0].ok).toBe(true);
    const current = JSON.parse(readFileSync(currentPath, 'utf-8'));
    expect(current.mcp.wigolo).toEqual({
      type: 'local', command: ['npx', '-y', 'wigolo'], enabled: true,
    });
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    expect(legacy.theme).toBe('system');
    expect(legacy.mcp.other).toBeDefined();
    expect(legacy.mcp.wigolo).toBeUndefined();
  });

  it('reports a failed OpenCode legacy migration instead of silent success', async () => {
    const configDir = join(dir, 'opencode-invalid-legacy');
    const currentPath = join(configDir, 'opencode.json');
    const legacyPath = join(configDir, 'config.json');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(legacyPath, '{ "mcp": { "wigolo": nope } }');
    const agents: DetectedAgent[] = [{
      id: 'opencode', displayName: 'OpenCode', detected: true,
      configPath: currentPath, installType: 'config-file',
    }];

    const results = await applyConfigs(agents, ['opencode']);

    expect(results[0].ok).toBe(false);
    expect(results[0].code).toBe('PARSE_ERROR');
    expect(results[0].message).toContain('legacy OpenCode config');
    const current = JSON.parse(readFileSync(currentPath, 'utf-8'));
    expect(current.mcp.wigolo.command).toEqual(['npx', '-y', 'wigolo']);
  });

  it('dryRun does not touch the filesystem', async () => {
    const path = join(dir, 'cursor', 'mcp.json');
    const agents: DetectedAgent[] = [{
      id: 'cursor', displayName: 'Cursor', detected: true, configPath: path, installType: 'config-file',
    }];
    const results = await applyConfigs(agents, ['cursor'], { dryRun: true });
    expect(results[0].ok).toBe(true);
    expect(results[0].dryRun).toBe(true);
    expect(() => readFileSync(path)).toThrow();
  });

  it('dryRun does not migrate an OpenCode legacy entry', async () => {
    const configDir = join(dir, 'opencode-dry-run');
    const currentPath = join(configDir, 'opencode.json');
    const legacyPath = join(configDir, 'config.json');
    mkdirSync(configDir, { recursive: true });
    const original = JSON.stringify({
      mcp: { wigolo: { type: 'local', command: 'npx', args: ['-y', 'wigolo'] } },
    }, null, 2) + '\n';
    writeFileSync(legacyPath, original);
    const agents: DetectedAgent[] = [{
      id: 'opencode', displayName: 'OpenCode', detected: true,
      configPath: currentPath, installType: 'config-file',
    }];

    const results = await applyConfigs(agents, ['opencode'], { dryRun: true });

    expect(results[0].ok).toBe(true);
    expect(readFileSync(legacyPath, 'utf-8')).toBe(original);
    expect(() => readFileSync(currentPath)).toThrow();
  });
});
