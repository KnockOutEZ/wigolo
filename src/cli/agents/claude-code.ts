import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
  return ['mcp', 'add', 'wigolo', '--', cmd.command, ...cmd.args];
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
  mkdirSync(skillsBase, { recursive: true });

  for (const dirName of SKILL_DIRS) {
    const files = readSkillDir(dirName);
    const dest = join(skillsBase, dirName);
    mkdirSync(dest, { recursive: true });

    for (const [relPath, content] of Object.entries(files)) {
      const target = join(dest, relPath);
      mkdirSync(join(dest, relPath, '..'), { recursive: true });
      writeFileSync(target, content, 'utf-8');
    }
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

  // Remove MCP
  try {
    execSync('claude mcp remove wigolo', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
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
