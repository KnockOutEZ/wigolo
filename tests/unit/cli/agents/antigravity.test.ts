import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `wigolo-antigravity-test-${Date.now()}`);
  mkdirSync(tmpHome, { recursive: true });
  vi.mocked(homedir).mockReturnValue(tmpHome);
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('antigravityHandler.detect', () => {
  it('returns true when the Antigravity data directory exists', async () => {
    mkdirSync(join(tmpHome, '.gemini', 'antigravity'), { recursive: true });
    const { antigravityHandler } = await import('../../../../src/cli/agents/antigravity.js');
    expect(antigravityHandler.detect()).toBe(true);
  });

  it('returns true when `agy` is on PATH', async () => {
    vi.mocked(spawnSync).mockImplementation(((_cmd: string, args: string[]) =>
      args[0] === 'agy'
        ? { status: 0, stdout: '/usr/bin/agy\n' }
        : { status: 1, stdout: '' }) as unknown as typeof spawnSync);
    const { antigravityHandler } = await import('../../../../src/cli/agents/antigravity.js');
    expect(antigravityHandler.detect()).toBe(true);
  });

  it('returns false when no product signal exists', async () => {
    mkdirSync(join(tmpHome, '.gemini', 'config'), { recursive: true });
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '' } as unknown as ReturnType<typeof spawnSync>);
    const { antigravityHandler } = await import('../../../../src/cli/agents/antigravity.js');
    expect(antigravityHandler.detect()).toBe(false);
  });
});

describe('antigravityHandler.installMcp', () => {
  it('writes mcpServers.wigolo to the documented global config', async () => {
    const { antigravityHandler } = await import('../../../../src/cli/agents/antigravity.js');
    await antigravityHandler.installMcp({ command: 'npx', args: ['-y', 'wigolo'] });
    const configPath = join(tmpHome, '.gemini', 'config', 'mcp_config.json');
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(parsed.mcpServers.wigolo).toEqual({
      command: 'npx',
      args: ['-y', 'wigolo'],
    });
  });

  it('preserves other MCP server entries', async () => {
    const configDir = join(tmpHome, '.gemini', 'config');
    const configPath = join(configDir, 'mcp_config.json');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
    );
    const { antigravityHandler } = await import('../../../../src/cli/agents/antigravity.js');
    await antigravityHandler.installMcp({ command: 'npx', args: ['-y', 'wigolo'] });
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(parsed.mcpServers.other).toEqual({ command: 'other' });
    expect(parsed.mcpServers.wigolo).toBeDefined();
  });
});

describe('antigravityHandler.uninstall', () => {
  it('removes only the wigolo MCP server entry', async () => {
    const { antigravityHandler } = await import('../../../../src/cli/agents/antigravity.js');
    await antigravityHandler.installMcp({ command: 'npx', args: ['-y', 'wigolo'] });
    const configPath = join(tmpHome, '.gemini', 'config', 'mcp_config.json');
    const before = JSON.parse(readFileSync(configPath, 'utf-8'));
    before.mcpServers.other = { command: 'other' };
    writeFileSync(configPath, JSON.stringify(before));

    const result = await antigravityHandler.uninstall();
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(parsed.mcpServers.wigolo).toBeUndefined();
    expect(parsed.mcpServers.other).toEqual({ command: 'other' });
    expect(result.removed).toEqual([
      '~/.gemini/config/mcp_config.json (wigolo entry)',
    ]);
    expect(existsSync(configPath)).toBe(true);
  });
});

describe('antigravity legacy config cleanup', () => {
  function writeLegacy(servers: Record<string, unknown>): string {
    const dir = join(tmpHome, '.antigravity');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: servers }));
    return path;
  }

  it('install drops a stale wigolo entry from ~/.antigravity/mcp.json and keeps others', async () => {
    const legacy = writeLegacy({ wigolo: { command: 'npx' }, other: { command: 'other' } });
    const { antigravityHandler } = await import('../../../../src/cli/agents/antigravity.js');
    await antigravityHandler.installMcp({ command: 'npx', args: ['-y', 'wigolo'] });
    const parsed = JSON.parse(readFileSync(legacy, 'utf-8'));
    expect(parsed.mcpServers.wigolo).toBeUndefined();
    expect(parsed.mcpServers.other).toEqual({ command: 'other' });
  });

  it('uninstall reports the removed legacy entry', async () => {
    writeLegacy({ wigolo: { command: 'npx' } });
    const { antigravityHandler } = await import('../../../../src/cli/agents/antigravity.js');
    const result = await antigravityHandler.uninstall();
    expect(result.removed).toEqual(['~/.antigravity/mcp.json (old wigolo entry)']);
  });

  it('leaves a legacy file without a wigolo entry untouched', async () => {
    const legacy = writeLegacy({ other: { command: 'other' } });
    const before = readFileSync(legacy, 'utf-8');
    const { antigravityHandler } = await import('../../../../src/cli/agents/antigravity.js');
    await antigravityHandler.installMcp({ command: 'npx', args: ['-y', 'wigolo'] });
    expect(readFileSync(legacy, 'utf-8')).toBe(before);
  });
});
