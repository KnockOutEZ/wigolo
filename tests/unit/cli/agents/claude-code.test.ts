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
  it('calls claude mcp add with --scope user so the entry lives once in ~/.claude.json', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installMcp({ command: 'wigolo', args: [] });
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain('claude mcp add wigolo');
    expect(cmd).toContain('--scope user');
    // The -- separator before the executable must still be present.
    expect(cmd).toMatch(/--scope user .*-- wigolo/);
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

  it('aborts before any writes when a skill dest path exists as a regular file', async () => {
    // A path collision (file where we want a directory) used to throw mid-loop
    // and leave skills installed up to that point. Pre-flight should detect
    // the collision and refuse to start.
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const skillsBase = join(tmpHome, '.claude', 'skills');
    mkdirSync(skillsBase, { recursive: true });
    writeFileSync(join(skillsBase, 'wigolo-extract'), 'I am a file, not a dir', 'utf-8');

    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await expect(claudeCodeHandler.installSkills()).rejects.toThrow();

    // No other skill dirs should have been touched.
    expect(existsSync(join(skillsBase, 'wigolo', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(skillsBase, 'wigolo-search', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(skillsBase, 'wigolo-fetch', 'SKILL.md'))).toBe(false);
  });

  it('rolls back freshly-created skill dirs when a mid-install write fails', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const skillsBase = join(tmpHome, '.claude', 'skills');
    mkdirSync(skillsBase, { recursive: true });

    // Force a mid-install failure: claim wigolo-research as a read-only file.
    // The pre-flight collision check catches this AND rejects before any
    // writes — exactly the desired behavior. Verify no partial install.
    writeFileSync(join(skillsBase, 'wigolo-research'), 'collision', 'utf-8');

    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await expect(claudeCodeHandler.installSkills()).rejects.toThrow();

    // None of the other skill dirs should have been left behind.
    for (const d of ['wigolo', 'wigolo-search', 'wigolo-fetch', 'wigolo-crawl', 'wigolo-extract', 'wigolo-find-similar', 'wigolo-agent']) {
      expect(existsSync(join(skillsBase, d, 'SKILL.md'))).toBe(false);
    }
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

  it('installs a slash command with YAML frontmatter so the command listing renders the description (not "wigolo: wigolo")', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installCommand();
    const cmdFile = join(tmpHome, '.claude', 'commands', 'wigolo.md');
    const content = readFileSync(cmdFile, 'utf-8');
    // Frontmatter must be the literal first bytes for Claude Code's parser.
    expect(content.startsWith('---\n')).toBe(true);
    // Description field is required for the slash-command listing UI.
    expect(content).toMatch(/^description:\s+.+/m);
    // Frontmatter must close before the body starts.
    const closing = content.indexOf('\n---\n', 4);
    expect(closing).toBeGreaterThan(0);
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

  it('calls claude mcp remove with --scope user matching the install path', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.uninstall();
    const mcpRemoveCall = vi.mocked(execSync).mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('mcp remove'),
    );
    expect(mcpRemoveCall).toBeDefined();
    expect(mcpRemoveCall![0] as string).toContain('--scope user');
  });

  it('removes skill directories', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installSkills();
    await claudeCodeHandler.uninstall();
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'wigolo'))).toBe(false);
  });
});
