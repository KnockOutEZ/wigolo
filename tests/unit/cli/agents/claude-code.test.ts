import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock node:os homedir
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

// Mock node:child_process execSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `wigolo-cc-test-${Date.now()}`);
  mkdirSync(tmpHome, { recursive: true });
  vi.mocked(homedir).mockReturnValue(tmpHome);
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('claudeCodeHandler.detect', () => {
  it('returns true when `which claude` succeeds', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/claude'));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    expect(claudeCodeHandler.detect()).toBe(true);
  });

  it('returns false when `which claude` throws', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    expect(claudeCodeHandler.detect()).toBe(false);
  });
});

describe('claudeCodeHandler.installMcp', () => {
  it('calls claude mcp add with the provided command', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installMcp({ command: 'wigolo', args: [] });
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('claude mcp add wigolo -- wigolo'),
      expect.any(Object),
    );
  });

  it('tolerates "already exists" errors', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('already exists'); });
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await expect(claudeCodeHandler.installMcp({ command: 'wigolo', args: [] })).resolves.not.toThrow();
  });
});

describe('claudeCodeHandler.installInstructions', () => {
  it('creates ~/.claude/CLAUDE.md with wigolo block', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installInstructions();
    const target = join(tmpHome, '.claude', 'CLAUDE.md');
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('<!-- wigolo:start');
    expect(content).toContain('wigolo MCP tools');
    expect(content).toContain('<!-- wigolo:end -->');
  });
});

describe('claudeCodeHandler.installSkills', () => {
  it('creates all 8 skill directories in ~/.claude/skills/', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installSkills();
    const skillsDir = join(tmpHome, '.claude', 'skills');
    const expected = [
      'wigolo', 'wigolo-search', 'wigolo-fetch', 'wigolo-crawl',
      'wigolo-extract', 'wigolo-find-similar', 'wigolo-research', 'wigolo-agent',
    ];
    for (const dir of expected) {
      expect(existsSync(join(skillsDir, dir, 'SKILL.md'))).toBe(true);
    }
  });

  it('creates wigolo/rules/ subdirectory', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installSkills();
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'wigolo', 'rules', 'cache-first.md'))).toBe(true);
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'wigolo', 'rules', 'synthesis.md'))).toBe(true);
  });
});

describe('claudeCodeHandler.installCommand', () => {
  it('creates ~/.claude/commands/wigolo.md', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installCommand();
    const cmdFile = join(tmpHome, '.claude', 'commands', 'wigolo.md');
    expect(existsSync(cmdFile)).toBe(true);
    const content = readFileSync(cmdFile, 'utf-8');
    expect(content).toContain('wigolo');
  });
});

describe('claudeCodeHandler.uninstall', () => {
  it('removes instruction block from CLAUDE.md', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installInstructions();
    const result = await claudeCodeHandler.uninstall();
    const claudeMd = join(tmpHome, '.claude', 'CLAUDE.md');
    const content = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf-8') : '';
    expect(content).not.toContain('<!-- wigolo:start');
    expect(result.removed.length).toBeGreaterThan(0);
  });

  it('removes skill directories', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installSkills();
    await claudeCodeHandler.uninstall();
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'wigolo'))).toBe(false);
  });
});
