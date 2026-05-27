import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  tmpHome = join(tmpdir(), `wigolo-windsurf-test-${Date.now()}`);
  mkdirSync(tmpHome, { recursive: true });
  vi.mocked(homedir).mockReturnValue(tmpHome);
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('windsurfHandler.detect', () => {
  it('returns true when ~/.codeium/windsurf dir exists', async () => {
    mkdirSync(join(tmpHome, '.codeium', 'windsurf'), { recursive: true });
    const { windsurfHandler } = await import('../../../../src/cli/agents/windsurf.js');
    expect(windsurfHandler.detect()).toBe(true);
  });

  it('returns true when ~/.windsurf legacy dir exists', async () => {
    mkdirSync(join(tmpHome, '.windsurf'), { recursive: true });
    const { windsurfHandler } = await import('../../../../src/cli/agents/windsurf.js');
    expect(windsurfHandler.detect()).toBe(true);
  });

  it('returns true when `windsurf` binary is on PATH', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/windsurf'));
    const { windsurfHandler } = await import('../../../../src/cli/agents/windsurf.js');
    expect(windsurfHandler.detect()).toBe(true);
  });

  it('returns false when neither dir nor binary found', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    const { windsurfHandler } = await import('../../../../src/cli/agents/windsurf.js');
    expect(windsurfHandler.detect()).toBe(false);
  });
});

describe('windsurfHandler.installMcp', () => {
  it('writes mcpServers.wigolo into ~/.codeium/windsurf/mcp_config.json', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { windsurfHandler } = await import('../../../../src/cli/agents/windsurf.js');
    await windsurfHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    const cfgPath = join(tmpHome, '.codeium', 'windsurf', 'mcp_config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(parsed.mcpServers.wigolo.command).toBe('npx');
    expect(parsed.mcpServers.wigolo.args).toEqual(['-y', '@staticn0va/wigolo']);
  });

  it('preserves existing mcp_config.json keys', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const windsurfDir = join(tmpHome, '.codeium', 'windsurf');
    mkdirSync(windsurfDir, { recursive: true });
    writeFileSync(
      join(windsurfDir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
    );
    const { windsurfHandler } = await import('../../../../src/cli/agents/windsurf.js');
    await windsurfHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    const parsed = JSON.parse(readFileSync(join(windsurfDir, 'mcp_config.json'), 'utf-8'));
    expect(parsed.mcpServers.other).toBeDefined();
    expect(parsed.mcpServers.wigolo).toBeDefined();
  });
});

describe('windsurfHandler.installInstructions', () => {
  it('writes wigolo block to ~/.codeium/windsurf/wigolo-instructions.md', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { windsurfHandler } = await import('../../../../src/cli/agents/windsurf.js');
    await windsurfHandler.installInstructions();
    const target = join(tmpHome, '.codeium', 'windsurf', 'wigolo-instructions.md');
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('<!-- wigolo:start');
    expect(content).toContain('wigolo MCP tools');
    expect(content).toContain('<!-- wigolo:end -->');
  });
});

describe('windsurfHandler.uninstall', () => {
  it('removes wigolo from mcp_config.json', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { windsurfHandler } = await import('../../../../src/cli/agents/windsurf.js');
    await windsurfHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    const result = await windsurfHandler.uninstall();
    const cfgPath = join(tmpHome, '.codeium', 'windsurf', 'mcp_config.json');
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(parsed.mcpServers?.wigolo).toBeUndefined();
    expect(result.removed.length).toBeGreaterThan(0);
  });

  it('removes the instructions file if present', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { windsurfHandler } = await import('../../../../src/cli/agents/windsurf.js');
    await windsurfHandler.installInstructions();
    const target = join(tmpHome, '.codeium', 'windsurf', 'wigolo-instructions.md');
    expect(existsSync(target)).toBe(true);
    const result = await windsurfHandler.uninstall();
    expect(existsSync(target)).toBe(false);
    expect(result.removed.some((r) => r.includes('wigolo-instructions.md'))).toBe(true);
  });
});

describe('windsurfHandler metadata', () => {
  it('has id=windsurf, supportsSkills=false', async () => {
    const { windsurfHandler } = await import('../../../../src/cli/agents/windsurf.js');
    expect(windsurfHandler.id).toBe('windsurf');
    expect(windsurfHandler.supportsSkills).toBe(false);
    expect(windsurfHandler.supportsCommands).toBe(false);
  });
});
