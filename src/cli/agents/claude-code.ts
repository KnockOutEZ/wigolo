import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { mergeBlock, removeBlock, readAsset, readSkillDir } from './utils.js';

function claudeDir(): string {
  return join(homedir(), '.claude');
}

function detect(): boolean {
  try {
    execSync('which claude', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function buildMcpArgs(cmd: { command: string; args: string[] }): string[] {
  // --scope user installs into ~/.claude.json once. Without it, claude defaults
  // to project scope and a fresh entry gets written for every cwd you run
  // `wigolo install` from, which stacks up stale rows.
  return ['mcp', 'add', 'wigolo', '--scope', 'user', '--', cmd.command, ...cmd.args];
}

async function installMcp(cmd: { command: string; args: string[] }): Promise<void> {
  const args = buildMcpArgs(cmd);
  try {
    execSync(`claude ${args.join(' ')}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const msg = e.message ?? '';
    // "already exists" is fine
    if (!msg.includes('already exists') && !msg.includes('already registered')) {
      throw err;
    }
  }
}

async function installInstructions(): Promise<void> {
  const block = readAsset('blocks/claude-code/CLAUDE.md.block');
  const target = join(claudeDir(), 'CLAUDE.md');
  mergeBlock(target, block);
}

const SKILL_DIRS = [
  'wigolo',
  'wigolo-search',
  'wigolo-fetch',
  'wigolo-crawl',
  'wigolo-extract',
  'wigolo-find-similar',
  'wigolo-research',
  'wigolo-agent',
];

async function installSkills(): Promise<void> {
  const skillsBase = join(claudeDir(), 'skills');

  const plan = SKILL_DIRS.map((dirName) => ({
    dirName,
    dest: join(skillsBase, dirName),
    files: readSkillDir(dirName),
  }));

  // Pre-flight: a regular file at any skill dest would cause mkdir to throw
  // mid-loop and leave a partial install. Detect before any writes.
  for (const { dest } of plan) {
    if (existsSync(dest) && !statSync(dest).isDirectory()) {
      throw new Error(
        `wigolo install: ${dest} exists but is not a directory — refuse to overwrite`,
      );
    }
  }

  mkdirSync(skillsBase, { recursive: true });

  // Track which top-level skill dirs we created so a mid-loop write failure
  // can be rolled back without touching pre-existing user content.
  const createdDirs: string[] = [];
  try {
    for (const { dest, files } of plan) {
      const dirExistedBefore = existsSync(dest);
      mkdirSync(dest, { recursive: true });
      if (!dirExistedBefore) createdDirs.push(dest);

      for (const [relPath, content] of Object.entries(files)) {
        const target = join(dest, relPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf-8');
      }
    }
  } catch (err) {
    for (const dir of createdDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort rollback
      }
    }
    throw err;
  }
}

async function installCommand(): Promise<void> {
  const content = readAsset('blocks/claude-code/wigolo-command.md');
  const commandsDir = join(claudeDir(), 'commands');
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(join(commandsDir, 'wigolo.md'), content, 'utf-8');
}

async function uninstall(): Promise<{ removed: string[] }> {
  const removed: string[] = [];

  // Remove MCP — match the scope used at install time (--scope user).
  try {
    execSync('claude mcp remove wigolo --scope user', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
    removed.push('MCP server (claude mcp remove)');
  } catch {
    // already gone or claude not found
  }

  // Remove instructions block
  const claudeMd = join(claudeDir(), 'CLAUDE.md');
  if (existsSync(claudeMd) && removeBlock(claudeMd)) {
    removed.push('~/.claude/CLAUDE.md block');
  }

  // Remove skill directories
  const skillsBase = join(claudeDir(), 'skills');
  for (const dirName of SKILL_DIRS) {
    const skillDir = join(skillsBase, dirName);
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true });
      removed.push(`~/.claude/skills/${dirName}`);
    }
  }

  // Remove command
  const commandFile = join(claudeDir(), 'commands', 'wigolo.md');
  if (existsSync(commandFile)) {
    rmSync(commandFile);
    removed.push('~/.claude/commands/wigolo.md');
  }

  return { removed };
}

export const claudeCodeHandler = {
  id: 'claude-code' as const,
  displayName: 'Claude Code',
  supportsSkills: true,
  supportsCommands: true,
  detect,
  installMcp,
  installInstructions,
  installSkills,
  installCommand,
  uninstall,
};
