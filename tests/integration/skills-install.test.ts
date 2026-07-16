import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// End-to-end at the engine boundary: per-agent simulated layouts under a temp
// HOME + temp project cwd. Verifies the full plan → apply → list → remove arc.

let tmpHome: string;
let tmpData: string;
let tmpCwd: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: tmpData })),
}));

async function engine() {
  return import('../../src/cli/agents/skills/index.js');
}

const FIXTURE_LEGACY = join(
  import.meta.dirname,
  'fixtures',
  'skills-legacy',
  'wigolo-search-SKILL.md',
);

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `wigolo-int-home-${stamp}`);
  tmpData = join(tmpdir(), `wigolo-int-data-${stamp}`);
  tmpCwd = join(tmpdir(), `wigolo-int-cwd-${stamp}`);
  for (const d of [tmpHome, tmpData, tmpCwd]) mkdirSync(d, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  for (const d of [tmpHome, tmpData, tmpCwd]) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('per-agent layouts — project scope', () => {
  it('codex+cursor+gemini install once into shared .agents/skills', async () => {
    const { installSkills } = await engine();
    installSkills({ scope: 'project', agents: ['codex', 'cursor', 'gemini-cli'], packs: ['wigolo'], cwd: tmpCwd });
    expect(existsSync(join(tmpCwd, '.agents', 'skills', 'wigolo', 'SKILL.md'))).toBe(true);
    // Only ONE tree exists (not three).
    expect(existsSync(join(tmpCwd, '.cursor', 'skills'))).toBe(false);
  });

  it('claude-code project → .claude/skills; cline project → .cline/skills', async () => {
    const { installSkills } = await engine();
    installSkills({ scope: 'project', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    installSkills({ scope: 'project', agents: ['cline'], packs: ['wigolo'], cwd: tmpCwd });
    expect(existsSync(join(tmpCwd, '.claude', 'skills', 'wigolo', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmpCwd, '.cline', 'skills', 'wigolo', 'SKILL.md'))).toBe(true);
  });

  it('windsurf project writes the owned rules file', async () => {
    const { installSkills } = await engine();
    installSkills({ scope: 'project', agents: ['windsurf'], cwd: tmpCwd });
    const owned = join(tmpCwd, '.windsurf', 'rules', 'wigolo.md');
    expect(existsSync(owned)).toBe(true);
    expect(readFileSync(owned, 'utf-8')).toContain('Wigolo');
  });
});

describe('per-agent layouts — global scope', () => {
  it('cursor global diverges to ~/.cursor/skills', async () => {
    const { installSkills } = await engine();
    installSkills({ scope: 'global', agents: ['cursor'], packs: ['wigolo'], cwd: tmpCwd });
    expect(existsSync(join(tmpHome, '.cursor', 'skills', 'wigolo', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmpHome, '.agents', 'skills'))).toBe(false);
  });

  it('windsurf global merges a fenced block into global_rules.md', async () => {
    const { installSkills } = await engine();
    installSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd });
    const gr = join(tmpHome, '.codeium', 'windsurf', 'memories', 'global_rules.md');
    expect(existsSync(gr)).toBe(true);
    const content = readFileSync(gr, 'utf-8');
    expect(content).toContain('<!-- wigolo:start');
    expect(content).toContain('<!-- wigolo:end -->');
  });

  it('windsurf global preserves the user preamble around the fenced block', async () => {
    const { installSkills } = await engine();
    const dir = join(tmpHome, '.codeium', 'windsurf', 'memories');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'global_rules.md'), '# My personal rules\n\nKeep these.\n', 'utf-8');
    installSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd });
    const content = readFileSync(join(dir, 'global_rules.md'), 'utf-8');
    expect(content).toContain('My personal rules');
    expect(content).toContain('<!-- wigolo:start');
  });

  it('windsurf global salvages an orphan start marker (LF) and backs it up', async () => {
    const { installSkills } = await engine();
    const dir = join(tmpHome, '.codeium', 'windsurf', 'memories');
    mkdirSync(dir, { recursive: true });
    // Corrupt state from an interrupted write: start marker with no end.
    writeFileSync(join(dir, 'global_rules.md'), 'user text\n<!-- wigolo:start orphan -->\nleaked\n', 'utf-8');
    installSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd });
    const content = readFileSync(join(dir, 'global_rules.md'), 'utf-8');
    // A proper matched block is present and a .wigolo-bak was written.
    expect(content).toContain('<!-- wigolo:end -->');
    expect(existsSync(join(dir, 'global_rules.md.wigolo-bak'))).toBe(true);
  });

  it('windsurf global salvages an orphan end marker (CRLF)', async () => {
    const { installSkills } = await engine();
    const dir = join(tmpHome, '.codeium', 'windsurf', 'memories');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'global_rules.md'), 'user text\r\nleaked\r\n<!-- wigolo:end -->\r\n', 'utf-8');
    installSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd });
    const content = readFileSync(join(dir, 'global_rules.md'), 'utf-8');
    expect(content).toContain('<!-- wigolo:start');
    expect(content).toContain('<!-- wigolo:end -->');
    expect(existsSync(join(dir, 'global_rules.md.wigolo-bak'))).toBe(true);
  });
});

describe('upgrade path — legacy bytes with no receipt', () => {
  it('plans update (not refuse) and rewrites + creates a receipt, NO force', async () => {
    const { planSkills, applySkillsPlan } = await engine();
    // Seed the OLD (v0.2.0-era) bytes on disk, with no receipt.
    const dir = join(tmpHome, '.claude', 'skills', 'wigolo-search');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), readFileSync(FIXTURE_LEGACY, 'utf-8'), 'utf-8');

    const plan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo-search'], cwd: tmpCwd });
    const action = plan.actions.find((a) => a.packs[0] === 'wigolo-search')!;
    const skillFile = action.files.find((f) => f.relPath === 'SKILL.md')!;
    expect(skillFile.status).toBe('update');
    expect(skillFile.adopted).toBe(true);

    applySkillsPlan(plan);
    // On-disk is now the current canonical (differs from the legacy fixture).
    const after = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    expect(after).not.toBe(readFileSync(FIXTURE_LEGACY, 'utf-8'));
    // A receipt was created.
    expect(existsSync(join(tmpData, 'skills', 'receipts.json'))).toBe(true);
  });
});

describe('unknown bytes refuse; force overrides', () => {
  it('no receipt + unknown bytes ⇒ refuse; force ⇒ update', async () => {
    const { planSkills } = await engine();
    const dir = join(tmpHome, '.claude', 'skills', 'wigolo-search');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'totally unknown user content', 'utf-8');

    const refusePlan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo-search'], cwd: tmpCwd });
    expect(refusePlan.actions.find((a) => a.packs[0] === 'wigolo-search')!.files.find((f) => f.relPath === 'SKILL.md')!.status).toBe('refuse');

    const forcePlan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo-search'], cwd: tmpCwd, force: true });
    expect(forcePlan.actions.find((a) => a.packs[0] === 'wigolo-search')!.files.find((f) => f.relPath === 'SKILL.md')!.status).toBe('update');
  });
});

describe('symlink dest — refuse (managed externally)', () => {
  it('a symlinked pack dir is refused and left intact', async () => {
    const { planSkills, applySkillsPlan } = await engine();
    const skillsBase = join(tmpHome, '.claude', 'skills');
    mkdirSync(skillsBase, { recursive: true });
    const external = join(tmpHome, 'external-managed');
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(skillsBase, 'wigolo'));

    const plan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    expect(plan.actions.find((a) => a.packs[0] === 'wigolo')!.status).toBe('refuse');
    const res = applySkillsPlan(plan);
    expect(res.refused.length).toBeGreaterThan(0);
    // The symlink is untouched (still a link to external).
    expect(existsSync(join(skillsBase, 'wigolo'))).toBe(true);
  });
});

describe('full arc — install, list, remove', () => {
  it('install → list installed → remove → list absent', async () => {
    const { installSkills, listSkills, removeSkills } = await engine();
    installSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo', 'wigolo-search'], cwd: tmpCwd });

    let list = listSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo', 'wigolo-search'], cwd: tmpCwd });
    expect(list.every((e) => e.state === 'installed')).toBe(true);

    removeSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo', 'wigolo-search'], cwd: tmpCwd });
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'wigolo', 'SKILL.md'))).toBe(false);

    list = listSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo', 'wigolo-search'], cwd: tmpCwd });
    expect(list.every((e) => e.state === 'absent')).toBe(true);
  });

  it('removeAllSkills sweeps every scope + agent even with an empty receipt store', async () => {
    const { installSkills, removeAllSkills } = await engine();
    // Install across two agents / scopes.
    installSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    installSkills({ scope: 'project', agents: ['cline'], packs: ['wigolo'], cwd: tmpCwd });
    // Wipe receipts → legacy/canonical-byte recognition must still clean up.
    rmSync(join(tmpData, 'skills', 'receipts.json'), { force: true });

    removeAllSkills({ cwd: tmpCwd });
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'wigolo', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(tmpCwd, '.cline', 'skills', 'wigolo', 'SKILL.md'))).toBe(false);
  });
});

describe('staggered-add per-pack version labeling', () => {
  it('two packs added in the same store share a receipt entry per base with per-pack versions', async () => {
    const { installSkills } = await engine();
    installSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    installSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo-search'], cwd: tmpCwd });
    const store = JSON.parse(readFileSync(join(tmpData, 'skills', 'receipts.json'), 'utf-8'));
    // Two distinct pack-dir keys, each with its own version-labeled pack entry.
    const keys = Object.keys(store);
    expect(keys.length).toBe(2);
    const allPacks = keys.flatMap((k) => Object.keys(store[k].packs));
    expect(allPacks.sort()).toEqual(['wigolo', 'wigolo-search']);
    for (const k of keys) {
      for (const p of Object.values(store[k].packs) as Array<{ version: string }>) {
        expect(typeof p.version).toBe('string');
        expect(p.version.length).toBeGreaterThan(0);
      }
    }
  });
});
