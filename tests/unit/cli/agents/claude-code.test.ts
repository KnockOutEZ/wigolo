import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock node:os homedir
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

// Mock node:child_process execSync + execFileSync. installMcp and uninstall
// now use execFileSync (argv array) instead of execSync (shell string) for
// safer argument handling.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

// installSkills now delegates to the skills engine, which writes receipts under
// getConfig().dataDir — point it at a temp dir so tests never touch ~/.wigolo.
vi.mock('../../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: tmpData })),
}));

import { execSync, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

let tmpHome: string;
let tmpData: string;

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `wigolo-cc-test-${stamp}`);
  tmpData = join(tmpdir(), `wigolo-cc-data-${stamp}`);
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(tmpData, { recursive: true });
  vi.mocked(homedir).mockReturnValue(tmpHome);
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpData, { recursive: true, force: true });
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
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installMcp({ command: 'wigolo', args: [] });
    const call = vi.mocked(execFileSync).mock.calls[0];
    const cmd = call[0] as string;
    const args = call[1] as string[];
    expect(cmd).toBe('claude');
    expect(args).toContain('mcp');
    expect(args).toContain('add');
    expect(args).toContain('wigolo');
    expect(args).toContain('--scope');
    expect(args).toContain('user');
    // The -- separator before the executable must still be present, and
    // the executable + its args must follow.
    const sepIdx = args.indexOf('--');
    expect(sepIdx).toBeGreaterThan(-1);
    expect(args.slice(sepIdx + 1)).toEqual(['wigolo']);
  });

  it('tolerates "already exists" errors', async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('already exists'); });
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await expect(claudeCodeHandler.installMcp({ command: 'wigolo', args: [] })).resolves.not.toThrow();
  });

  it('falls back to writing ~/.claude.json directly when the claude CLI is absent (ENOENT)', async () => {
    // execFileSync('claude', [...]) throws ENOENT. We expect the handler to NOT
    // propagate the error and to instead drop the MCP entry into ~/.claude.json
    // so the user is still wired up.
    vi.mocked(execFileSync).mockImplementation(() => {
      const err = Object.assign(new Error(`spawn claude ENOENT`), { code: 'ENOENT' });
      throw err;
    });
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await expect(
      claudeCodeHandler.installMcp({ command: 'npx', args: ['-y', 'wigolo'] }),
    ).resolves.not.toThrow();

    const claudeJson = join(tmpHome, '.claude.json');
    expect(existsSync(claudeJson)).toBe(true);
    const parsed = JSON.parse(readFileSync(claudeJson, 'utf-8'));
    expect(parsed.mcpServers.wigolo.command).toBe('npx');
    expect(parsed.mcpServers.wigolo.args).toEqual(['-y', 'wigolo']);
  });

  it('falls back when execFileSync reports "command not found" (shell stderr) instead of ENOENT', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('/bin/sh: claude: command not found');
    });
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await expect(
      claudeCodeHandler.installMcp({ command: 'wigolo', args: [] }),
    ).resolves.not.toThrow();

    expect(existsSync(join(tmpHome, '.claude.json'))).toBe(true);
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

describe('claudeCodeHandler.installSkills (engine-delegated)', () => {
  it('installs ALL 11 canonical packs (incl. cache/diff/watch) into ~/.claude/skills/', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installSkills();
    const skillsDir = join(tmpHome, '.claude', 'skills');
    const expected = [
      'wigolo', 'wigolo-search', 'wigolo-fetch', 'wigolo-crawl', 'wigolo-cache',
      'wigolo-extract', 'wigolo-find-similar', 'wigolo-research', 'wigolo-agent',
      'wigolo-diff', 'wigolo-watch',
    ];
    for (const dir of expected) {
      expect(existsSync(join(skillsDir, dir, 'SKILL.md')), dir).toBe(true);
    }
  });

  it('creates wigolo/rules/ subdirectory', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installSkills();
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'wigolo', 'rules', 'cache-first.md'))).toBe(true);
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'wigolo', 'rules', 'synthesis.md'))).toBe(true);
  });

  it('writes a receipt store under the configured dataDir', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installSkills();
    expect(existsSync(join(tmpData, 'skills', 'receipts.json'))).toBe(true);
  });

  it('refuses (does NOT throw, does NOT overwrite) when a pack-dir slot is a regular file', async () => {
    // The engine surfaces this as a refused action rather than throwing; the
    // colliding file is left intact and other packs still install.
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const skillsBase = join(tmpHome, '.claude', 'skills');
    mkdirSync(skillsBase, { recursive: true });
    writeFileSync(join(skillsBase, 'wigolo-extract'), 'I am a file, not a dir', 'utf-8');

    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await expect(claudeCodeHandler.installSkills()).resolves.toBeUndefined();

    // Colliding file untouched; a non-colliding pack still installed.
    expect(readFileSync(join(skillsBase, 'wigolo-extract'), 'utf-8')).toBe('I am a file, not a dir');
    expect(existsSync(join(skillsBase, 'wigolo', 'SKILL.md'))).toBe(true);
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
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.uninstall();
    const mcpRemoveCall = vi.mocked(execFileSync).mock.calls.find(
      (c) => c[0] === 'claude' && Array.isArray(c[1]) && (c[1] as string[]).includes('remove'),
    );
    expect(mcpRemoveCall).toBeDefined();
    const args = mcpRemoveCall![1] as string[];
    expect(args).toContain('remove');
    expect(args).toContain('wigolo');
    expect(args).toContain('--scope');
    expect(args).toContain('user');
  });

  it('does NOT tear down skill directories (sweep is owned by the engine, wired later)', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    const { claudeCodeHandler } = await import('../../../../src/cli/agents/claude-code.js');
    await claudeCodeHandler.installSkills();
    await claudeCodeHandler.uninstall();
    // Skill dirs must remain — a naive recursive rm was removed on purpose so
    // receipts + user-modified files are respected by the future sweep.
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'wigolo', 'SKILL.md'))).toBe(true);
  });
});
