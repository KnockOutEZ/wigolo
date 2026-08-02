import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  resolveTarget,
  allTargets,
  SUPPORTED_AGENTS,
} from '../../../../../src/cli/agents/skills/targets.js';

const HOME = join('/tmp', 'fake-home');
const CWD = join('/tmp', 'fake-project');

describe('resolveTarget — project scope', () => {
  it('claude-code → <cwd>/.claude/skills, skill-dirs', () => {
    const t = resolveTarget('claude-code', 'project', CWD, HOME)!;
    expect(t.kind).toBe('skill-dirs');
    expect(t.basePath).toBe(join(CWD, '.claude', 'skills'));
  });

  it('codex/cursor/gemini-cli all share <cwd>/.agents/skills', () => {
    for (const a of ['codex', 'cursor', 'gemini-cli']) {
      const t = resolveTarget(a, 'project', CWD, HOME)!;
      expect(t.basePath, a).toBe(join(CWD, '.agents', 'skills'));
      expect(t.kind).toBe('skill-dirs');
    }
  });

  it('cline → <cwd>/.cline/skills', () => {
    const t = resolveTarget('cline', 'project', CWD, HOME)!;
    expect(t.basePath).toBe(join(CWD, '.cline', 'skills'));
  });

  it('windsurf project → owned .windsurf/rules/wigolo.md', () => {
    const t = resolveTarget('windsurf', 'project', CWD, HOME)!;
    expect(t.kind).toBe('owned-rules-file');
    expect(t.basePath).toBe(join(CWD, '.windsurf', 'rules', 'wigolo.md'));
  });
});

describe('resolveTarget — global scope', () => {
  it('claude-code → ~/.claude/skills', () => {
    const t = resolveTarget('claude-code', 'global', CWD, HOME)!;
    expect(t.basePath).toBe(join(HOME, '.claude', 'skills'));
  });

  it('cursor global diverges to ~/.cursor/skills (NOT .agents)', () => {
    const t = resolveTarget('cursor', 'global', CWD, HOME)!;
    expect(t.basePath).toBe(join(HOME, '.cursor', 'skills'));
  });

  it('codex + gemini-cli global stay in ~/.agents/skills', () => {
    for (const a of ['codex', 'gemini-cli']) {
      const t = resolveTarget(a, 'global', CWD, HOME)!;
      expect(t.basePath, a).toBe(join(HOME, '.agents', 'skills'));
    }
  });

  it('cline global → ~/.cline/skills', () => {
    const t = resolveTarget('cline', 'global', CWD, HOME)!;
    expect(t.basePath).toBe(join(HOME, '.cline', 'skills'));
  });

  it('windsurf global → fenced-block in global_rules.md', () => {
    const t = resolveTarget('windsurf', 'global', CWD, HOME)!;
    expect(t.kind).toBe('fenced-block');
    expect(t.basePath).toBe(
      join(HOME, '.codeium', 'windsurf', 'memories', 'global_rules.md'),
    );
  });
});

describe('resolveTarget — unknown agent', () => {
  it('returns undefined', () => {
    expect(resolveTarget('vscode', 'project', CWD, HOME)).toBeUndefined();
    expect(resolveTarget('nonsense', 'global', CWD, HOME)).toBeUndefined();
  });
});

describe('allTargets', () => {
  it('emits one target per supported agent × both scopes', () => {
    const all = allTargets(CWD, HOME);
    expect(all).toHaveLength(SUPPORTED_AGENTS.length * 2);
  });
});
