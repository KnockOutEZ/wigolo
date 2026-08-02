import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { mergeBlock, removeBlock, readAsset, mergeMcpJson } from './utils.js';
import { installSkills as installSkillsEngine } from './skills/index.js';

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

function isClaudeCliMissing(err: NodeJS.ErrnoException): boolean {
  if (err.code === 'ENOENT') return true;
  const msg = err.message ?? '';
  return /claude: not found|claude: command not found|spawn claude ENOENT/i.test(msg);
}

function fallbackToClaudeJson(cmd: { command: string; args: string[] }): string {
  // Host `claude` CLI not on PATH. The user-scope MCP store the CLI would
  // normally maintain lives at ~/.claude.json (a sibling of ~/.claude/, not
  // inside it). Write the entry directly so the user is still wired up.
  const configPath = join(homedir(), '.claude.json');
  mergeMcpJson(configPath, { command: cmd.command, args: cmd.args }, ['mcpServers', 'wigolo']);
  return configPath;
}

async function installMcp(cmd: { command: string; args: string[] }): Promise<void> {
  const args = buildMcpArgs(cmd);
  try {
    execFileSync('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const msg = e.message ?? '';
    if (msg.includes('already exists') || msg.includes('already registered')) {
      return;
    }
    if (isClaudeCliMissing(e)) {
      fallbackToClaudeJson(cmd);
      return;
    }
    throw err;
  }
}

async function installInstructions(): Promise<void> {
  const block = readAsset('blocks/claude-code/CLAUDE.md.block');
  const target = join(claudeDir(), 'CLAUDE.md');
  mergeBlock(target, block);
}

async function installSkills(): Promise<void> {
  // Delegate to the skills engine: global scope, ALL catalog packs (11, incl.
  // cache/diff/watch), for claude-code. The engine handles receipts, adopt /
  // upgrade / refuse resolution, and rollback.
  installSkillsEngine({ scope: 'global', agents: ['claude-code'], cwd: process.cwd() });
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
    execFileSync('claude', ['mcp', 'remove', 'wigolo', '--scope', 'user'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    removed.push('MCP server (claude mcp remove)');
  } catch {
    // already gone or claude not found
  }

  // Remove instructions block
  const claudeMd = join(claudeDir(), 'CLAUDE.md');
  if (existsSync(claudeMd) && removeBlock(claudeMd)) {
    removed.push('~/.claude/CLAUDE.md block');
  }

  // NOTE: skill-dir teardown is owned by the skills engine's uninstall sweep
  // (wired in a later slice). Intentionally NOT reimplemented here — a naive
  // recursive rm would ignore receipts and user-modified files.

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
