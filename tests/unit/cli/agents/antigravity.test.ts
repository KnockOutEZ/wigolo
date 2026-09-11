import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
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
    vi.mocked(execSync).mockImplementation((command) => {
      if (command === 'which agy') return Buffer.from('/usr/bin/agy');
      throw new Error('not found');
    });
    const { antigravityHandler } = await import('../../../../src/cli/agents/antigravity.js');
    expect(antigravityHandler.detect()).toBe(true);
  });

  it('returns false when no product signal exists', async () => {
    mkdirSync(join(tmpHome, '.gemini', 'config'), { recursive: true });
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
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
