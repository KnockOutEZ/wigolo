/**
 * Cline integration (skills-only).
 *
 * Cline is a VS Code extension that reads skill dirs from `.cline/skills/`
 * (project) or `~/.cline/skills/` (global). It has no wigolo-managed MCP config
 * path here, so installMcp is an actionable no-op and installInstructions is a
 * noop. Skill install is delegated to the P4 skills engine.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { installSkills } from './skills/index.js';

function detect(): boolean {
  const cwd = process.cwd();
  // Project markers.
  if (existsSync(join(cwd, '.clinerules'))) return true; // file or dir
  if (existsSync(join(cwd, '.cline'))) return true;
  // Global markers.
  const home = homedir();
  if (existsSync(join(home, '.cline'))) return true;
  if (existsSync(join(home, 'Documents', 'Cline'))) return true;
  // PATH binary — bonus signal only (never the sole basis is fine, still true).
  try {
    execSync('which cline', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

async function installMcp(_cmd: { command: string; args: string[] }): Promise<void> {
  // No wigolo-managed MCP config for cline. Actionable no-op — the skills layer
  // carries the tool guidance instead. Kept intentionally silent (MCP-mode
  // handlers must not write to stdout).
  void _cmd;
}

async function installInstructions(): Promise<void> {
  // No separate instructions file — the skill packs are the guidance.
}

async function installSkillsHandler(): Promise<void> {
  // Global scope, all catalog packs, for cline.
  installSkills({ scope: 'global', agents: ['cline'], cwd: process.cwd() });
}

async function uninstall(): Promise<{ removed: string[] }> {
  // Skill-dir teardown is owned by the engine's uninstall sweep (a later slice
  // wires the call site). Nothing agent-specific to remove here yet.
  return { removed: [] };
}

export const clineHandler = {
  id: 'cline' as const,
  displayName: 'Cline',
  supportsSkills: true,
  supportsCommands: false,
  detect,
  installMcp,
  installInstructions,
  installSkills: installSkillsHandler,
  uninstall,
};
