import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Scope, Target, TargetKind } from './types.js';

/**
 * The static target matrix — where each agent's skills/rules land per scope.
 *
 * Resolved lazily (through homedir()/cwd) so tests that mock node:os see the
 * temp HOME. `skill-dirs` basePath is the parent dir that holds `<pack>/`
 * subdirs; `owned-rules-file`/`fenced-block` basePath is the file itself.
 */

export const SUPPORTED_AGENTS = [
  'claude-code',
  'codex',
  'cursor',
  'gemini-cli',
  'cline',
  'windsurf',
] as const;

export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];

/** The single all-or-nothing pseudo-pack windsurf receives. */
export const WINDSURF_DIGEST_PACK = 'wigolo-digest';

interface AgentTargetSpec {
  kind: TargetKind;
  /** Given (home, cwd, scope) → absolute base path. */
  project(home: string, cwd: string): { basePath: string; relLabel: string };
  global(home: string): { basePath: string; relLabel: string };
}

const SPECS: Record<SupportedAgent, AgentTargetSpec> = {
  'claude-code': {
    kind: 'skill-dirs',
    project: (_h, cwd) => ({
      basePath: join(cwd, '.claude', 'skills'),
      relLabel: '.claude/skills',
    }),
    global: (h) => ({
      basePath: join(h, '.claude', 'skills'),
      relLabel: '~/.claude/skills',
    }),
  },
  codex: {
    kind: 'skill-dirs',
    project: (_h, cwd) => ({
      basePath: join(cwd, '.agents', 'skills'),
      relLabel: '.agents/skills',
    }),
    global: (h) => ({
      basePath: join(h, '.agents', 'skills'),
      relLabel: '~/.agents/skills',
    }),
  },
  cursor: {
    kind: 'skill-dirs',
    project: (_h, cwd) => ({
      basePath: join(cwd, '.agents', 'skills'),
      relLabel: '.agents/skills',
    }),
    global: (h) => ({
      basePath: join(h, '.cursor', 'skills'),
      relLabel: '~/.cursor/skills',
    }),
  },
  'gemini-cli': {
    kind: 'skill-dirs',
    project: (_h, cwd) => ({
      basePath: join(cwd, '.agents', 'skills'),
      relLabel: '.agents/skills',
    }),
    global: (h) => ({
      basePath: join(h, '.agents', 'skills'),
      relLabel: '~/.agents/skills',
    }),
  },
  cline: {
    kind: 'skill-dirs',
    project: (_h, cwd) => ({
      basePath: join(cwd, '.cline', 'skills'),
      relLabel: '.cline/skills',
    }),
    global: (h) => ({
      basePath: join(h, '.cline', 'skills'),
      relLabel: '~/.cline/skills',
    }),
  },
  windsurf: {
    kind: 'owned-rules-file', // project kind; global is fenced-block (resolved below)
    project: (_h, cwd) => ({
      basePath: join(cwd, '.windsurf', 'rules', 'wigolo.md'),
      relLabel: '.windsurf/rules/wigolo.md',
    }),
    global: (h) => ({
      basePath: join(h, '.codeium', 'windsurf', 'memories', 'global_rules.md'),
      relLabel: '~/.codeium/windsurf/memories/global_rules.md',
    }),
  },
};

/** Resolve one agent's target at a given scope. */
export function resolveTarget(
  agent: string,
  scope: Scope,
  cwd: string,
  home: string = homedir(),
): Target | undefined {
  const spec = SPECS[agent as SupportedAgent];
  if (!spec) return undefined;

  const { basePath, relLabel } =
    scope === 'project' ? spec.project(home, cwd) : spec.global(home);

  // Windsurf is the only agent whose kind differs by scope: an owned file at
  // project scope, a fenced block inside a shared file at global scope.
  const kind: TargetKind =
    agent === 'windsurf'
      ? scope === 'project'
        ? 'owned-rules-file'
        : 'fenced-block'
      : spec.kind;

  return { agent, scope, kind, basePath, relLabel };
}

/** All (agent × scope) targets across BOTH scopes for a given cwd/home. */
export function allTargets(cwd: string, home: string = homedir()): Target[] {
  const out: Target[] = [];
  for (const agent of SUPPORTED_AGENTS) {
    for (const scope of ['project', 'global'] as const) {
      const t = resolveTarget(agent, scope, cwd, home);
      if (t) out.push(t);
    }
  }
  return out;
}
