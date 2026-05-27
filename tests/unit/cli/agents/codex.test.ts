import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from '@iarna/toml';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Mock process.cwd to return a temp dir so installInstructions
// doesn't write to the actual project root during tests.
let tmpCwd: string;

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `wigolo-codex-test-${Date.now()}`);
  tmpCwd = join(tmpdir(), `wigolo-codex-cwd-${Date.now()}`);
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(tmpCwd, { recursive: true });
  vi.mocked(homedir).mockReturnValue(tmpHome);
  vi.spyOn(process, 'cwd').mockReturnValue(tmpCwd);
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpCwd, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('codexHandler.detect', () => {
  it('returns true when `codex` binary is on PATH', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/codex'));
    const { codexHandler } = await import('../../../../src/cli/agents/codex.js');
    expect(codexHandler.detect()).toBe(true);
  });

  it('returns true when ~/.codex dir exists', async () => {
    mkdirSync(join(tmpHome, '.codex'), { recursive: true });
    const { codexHandler } = await import('../../../../src/cli/agents/codex.js');
    expect(codexHandler.detect()).toBe(true);
  });

  it('returns false when neither binary nor dir found', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    const { codexHandler } = await import('../../../../src/cli/agents/codex.js');
    expect(codexHandler.detect()).toBe(false);
  });
});

describe('codexHandler.installMcp', () => {
  it('writes mcp_servers.wigolo into ~/.codex/config.toml', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { codexHandler } = await import('../../../../src/cli/agents/codex.js');
    await codexHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    const cfgPath = join(tmpHome, '.codex', 'config.toml');
    expect(existsSync(cfgPath)).toBe(true);
    const content = readFileSync(cfgPath, 'utf-8');
    expect(content).toContain('[mcp_servers.wigolo]');
    expect(content).toContain('npx');
  });

  it('preserves other tables in an existing config.toml', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const cfgPath = join(codexDir, 'config.toml');
    writeFileSync(cfgPath, '[mcp_servers.other]\ncommand = "other-cmd"\n');
    const { codexHandler } = await import('../../../../src/cli/agents/codex.js');
    await codexHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    const content = readFileSync(cfgPath, 'utf-8');
    expect(content).toContain('[mcp_servers.other]');
    expect(content).toContain('other-cmd');
    expect(content).toContain('[mcp_servers.wigolo]');
  });

  it('updates the wigolo entry in place on a second install — no duplicate/corruption', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { codexHandler } = await import('../../../../src/cli/agents/codex.js');
    const cfgPath = join(tmpHome, '.codex', 'config.toml');

    // First install: npx form.
    await codexHandler.installMcp({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    // Second install over the existing file with a different command (e.g. global bin).
    await codexHandler.installMcp({ command: 'wigolo', args: [] });

    const content = readFileSync(cfgPath, 'utf-8');
    // The section must appear exactly once — re-install updates in place.
    const occurrences = content.split('[mcp_servers.wigolo]').length - 1;
    expect(occurrences).toBe(1);
    // And it must hold the second install's command, not a stale/duplicated value.
    const parsed = parseToml(content) as { mcp_servers?: { wigolo?: { command?: string } } };
    expect(parsed.mcp_servers?.wigolo?.command).toBe('wigolo');
  });
});

describe('codexHandler.installInstructions', () => {
  it('writes wigolo block to AGENTS.md in cwd', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { codexHandler } = await import('../../../../src/cli/agents/codex.js');
    await codexHandler.installInstructions();
    const target = join(tmpCwd, 'AGENTS.md');
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('<!-- wigolo:start');
    expect(content).toContain('wigolo MCP tools');
    expect(content).toContain('<!-- wigolo:end -->');
  });
});

describe('codexHandler.uninstall', () => {
  it('removes wigolo from config.toml', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { codexHandler } = await import('../../../../src/cli/agents/codex.js');
    mkdirSync(join(tmpHome, '.codex'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.codex', 'config.toml'),
      '[mcp_servers.wigolo]\ncommand = "npx"\nargs = ["-y", "@staticn0va/wigolo"]\n',
    );
    const result = await codexHandler.uninstall();
    const content = readFileSync(join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).not.toContain('[mcp_servers.wigolo]');
    expect(result.removed.some((r) => r.includes('config.toml'))).toBe(true);
  });
});

describe('codexHandler metadata', () => {
  it('has id=codex, supportsSkills=false', async () => {
    const { codexHandler } = await import('../../../../src/cli/agents/codex.js');
    expect(codexHandler.id).toBe('codex');
    expect(codexHandler.supportsSkills).toBe(false);
    expect(codexHandler.supportsCommands).toBe(false);
  });
});
