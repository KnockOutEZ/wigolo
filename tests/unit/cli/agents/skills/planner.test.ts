import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpHome: string;
let tmpData: string;
let tmpCwd: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

vi.mock('../../../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: tmpData })),
}));

async function load() {
  return import('../../../../../src/cli/agents/skills/planner.js');
}
async function loadCat() {
  return import('../../../../../src/cli/agents/skills/catalog.js');
}

// The real v0.2.0-era SKILL.md whose hash is registered in the legacy manifest.
const FIXTURE_LEGACY = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'integration',
  'fixtures',
  'skills-legacy',
  'wigolo-search-SKILL.md',
);

function sha(s: string): string {
  return createHash('sha256').update(s.replace(/\r\n/g, '\n'), 'utf-8').digest('hex');
}

/** Snapshot a dir tree into a single hash for "touched nothing" assertions. */
function treeHash(dir: string): string {
  const h = createHash('sha256');
  function walk(d: string, base: string) {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, name.name);
      const rel = full.slice(base.length);
      if (name.isDirectory()) {
        h.update(`D:${rel}\n`);
        walk(full, base);
      } else if (name.isSymbolicLink()) {
        h.update(`L:${rel}\n`);
      } else {
        h.update(`F:${rel}:${readFileSync(full, 'utf-8')}\n`);
      }
    }
  }
  walk(dir, dir);
  return h.digest('hex');
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `wigolo-plan-home-${stamp}`);
  tmpData = join(tmpdir(), `wigolo-plan-data-${stamp}`);
  tmpCwd = join(tmpdir(), `wigolo-plan-cwd-${stamp}`);
  for (const d of [tmpHome, tmpData, tmpCwd]) mkdirSync(d, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  for (const d of [tmpHome, tmpData, tmpCwd]) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('planSkills — fresh install (create)', () => {
  it('plans create for every pack file on a clean machine', async () => {
    const { planSkills } = await load();
    const plan = planSkills({ scope: 'global', agents: ['claude-code'], cwd: tmpCwd });
    const wigoloAction = plan.actions.find((a) => a.packs[0] === 'wigolo')!;
    expect(wigoloAction.status).toBe('create');
    expect(wigoloAction.files.every((f) => f.status === 'create')).toBe(true);
    expect(wigoloAction.canonicalKey.endsWith(join('skills', 'wigolo'))).toBe(true);
  });

  it('touches NOTHING on disk (pure plan)', async () => {
    const { planSkills } = await load();
    const before = treeHash(tmpHome);
    planSkills({ scope: 'global', agents: ['claude-code'], cwd: tmpCwd });
    expect(treeHash(tmpHome)).toBe(before);
  });

  it('fresh-machine plan with NO existing parent dirs still resolves keys, no mkdir', async () => {
    const { planSkills } = await load();
    rmSync(tmpHome, { recursive: true, force: true }); // home doesn't even exist
    const plan = planSkills({ scope: 'global', agents: ['claude-code'], cwd: tmpCwd });
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(existsSync(join(tmpHome, '.claude'))).toBe(false);
  });
});

describe('planSkills — shared-path dedup', () => {
  it('.agents/skills planned ONCE across codex+cursor+gemini, agents[] lists all', async () => {
    const { planSkills } = await load();
    const plan = planSkills({
      scope: 'project',
      agents: ['codex', 'cursor', 'gemini-cli'],
      packs: ['wigolo'],
      cwd: tmpCwd,
    });
    const wigolo = plan.actions.filter((a) => a.packs[0] === 'wigolo');
    expect(wigolo).toHaveLength(1);
    expect(wigolo[0].agents.sort()).toEqual(['codex', 'cursor', 'gemini-cli']);
    expect(wigolo[0].path).toBe(join(tmpCwd, '.agents', 'skills', 'wigolo'));
  });
});

describe('planSkills — ADD resolution negatives', () => {
  it('symlink dest ⇒ refuse (no force)', async () => {
    const { planSkills } = await load();
    const base = join(tmpHome, '.claude', 'skills', 'wigolo');
    mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
    const realTarget = join(tmpHome, 'real-dir');
    mkdirSync(realTarget);
    symlinkSync(realTarget, base);
    const plan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    const action = plan.actions.find((a) => a.packs[0] === 'wigolo')!;
    // The SKILL.md path under the symlinked dir resolves as symlink? No — the
    // pack DIR is the symlink. Files under it lstat via the link. Assert refuse.
    expect(action.status).toBe('refuse');
    expect(action.reason).toMatch(/symlink|managed/i);
  });

  it('dangling symlink dest ⇒ refuse', async () => {
    const { planSkills } = await load();
    mkdirSync(join(tmpHome, '.codeium', 'windsurf', 'memories'), { recursive: true });
    const dest = join(tmpHome, '.codeium', 'windsurf', 'memories', 'global_rules.md');
    symlinkSync(join(tmpHome, 'nonexistent-target'), dest);
    const plan = planSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd });
    const action = plan.actions.find((a) => a.agents.includes('windsurf'))!;
    expect(action.status).toBe('refuse');
  });

  it('dest-is-file where a pack dir must go ⇒ refuse even WITH force', async () => {
    const { planSkills } = await load();
    // For windsurf owned-file we test the file case; for skill-dirs, the pack
    // dir being a regular file surfaces per-file dir-collision on children.
    const skillsBase = join(tmpHome, '.claude', 'skills');
    mkdirSync(skillsBase, { recursive: true });
    writeFileSync(join(skillsBase, 'wigolo'), 'i am a file', 'utf-8');
    const plan = planSkills({
      scope: 'global',
      agents: ['claude-code'],
      packs: ['wigolo'],
      cwd: tmpCwd,
      force: true,
    });
    const action = plan.actions.find((a) => a.packs[0] === 'wigolo')!;
    // SKILL.md path = <file>/SKILL.md — parent is a file, lstat of child = absent,
    // but write would fail. The planner marks the pack refuse via file dir-collision
    // OR create; the executor must guard. Assert not silently 'create' when the
    // pack-dir slot is a regular file: we detect this at the pack level.
    expect(action.status).toBe('refuse');
  });
});

describe('planSkills — adopt + upgrade', () => {
  it('no receipt + bytes == canonical ⇒ adopt (adopted:true)', async () => {
    const { planSkills } = await load();
    const { loadPack } = await loadCat();
    const pack = loadPack('wigolo-search');
    const canonical = pack.files['SKILL.md'];
    const dir = join(tmpHome, '.claude', 'skills', 'wigolo-search');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), canonical, 'utf-8');
    const plan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo-search'], cwd: tmpCwd });
    const action = plan.actions.find((a) => a.packs[0] === 'wigolo-search')!;
    const f = action.files.find((x) => x.relPath === 'SKILL.md')!;
    expect(f.status).toBe('adopt');
    expect(f.adopted).toBe(true);
  });

  it('CRLF-on-disk still resolves unchanged/adopt (EOL-normalized compare)', async () => {
    const { planSkills } = await load();
    const { loadPack } = await loadCat();
    const pack = loadPack('wigolo-search');
    const canonical = pack.files['SKILL.md'];
    const crlf = canonical.replace(/\n/g, '\r\n');
    const dir = join(tmpHome, '.claude', 'skills', 'wigolo-search');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), crlf, 'utf-8');
    const plan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo-search'], cwd: tmpCwd });
    const f = plan.actions.find((a) => a.packs[0] === 'wigolo-search')!.files.find((x) => x.relPath === 'SKILL.md')!;
    expect(f.status).toBe('adopt'); // CRLF-normalized == canonical
  });

  it('legacy-hash bytes with no receipt ⇒ update (adopt-and-upgrade, no force)', async () => {
    const { planSkills } = await load();
    const { loadPack } = await loadCat();
    const pack = loadPack('wigolo-search');
    const currentHash = sha(pack.files['SKILL.md']);

    // Use the REAL legacy fixture bytes: a prior wigolo version's SKILL.md whose
    // hash is registered in assets/legacy-skill-hashes.json but differs from the
    // current canonical. Writing those exact bytes and planning must yield
    // update+adopted (the legacy-hash branch of resolveFileAdd). If that branch
    // were deleted the status would fall through to 'refuse' and this fails.
    const legacyBytes = readFileSync(FIXTURE_LEGACY, 'utf-8');
    expect(sha(legacyBytes), 'fixture must differ from current canonical').not.toBe(currentHash);

    const dir = join(tmpHome, '.claude', 'skills', 'wigolo-search');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), legacyBytes, 'utf-8');

    const plan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo-search'], cwd: tmpCwd });
    const f = plan.actions
      .find((a) => a.packs[0] === 'wigolo-search')!
      .files.find((x) => x.relPath === 'SKILL.md')!;
    expect(f.status).toBe('update');
    expect(f.adopted).toBe(true);
  });
});

describe('planSkills — windsurf digest', () => {
  it('project scope ⇒ owned-rules-file create with digest note', async () => {
    const { planSkills } = await load();
    const plan = planSkills({ scope: 'project', agents: ['windsurf'], cwd: tmpCwd });
    const action = plan.actions.find((a) => a.agents.includes('windsurf'))!;
    expect(action.kind).toBe('owned-rules-file');
    expect(action.status).toBe('create');
    expect(plan.notes.some((n) => /digest \(all tools\)/.test(n))).toBe(true);
  });

  it('global scope refuses when merged global_rules.md would exceed 6000 chars', async () => {
    const { planSkills } = await load();
    const dir = join(tmpHome, '.codeium', 'windsurf', 'memories');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'global_rules.md'), 'x'.repeat(5900), 'utf-8');
    const plan = planSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd });
    const action = plan.actions.find((a) => a.agents.includes('windsurf'))!;
    expect(action.status).toBe('refuse');
    expect(action.reason).toMatch(/6000|trim your global rules|project scope/);
  });

  it('per-pack selection against windsurf is noted as digest-only', async () => {
    const { planSkills } = await load();
    const plan = planSkills({ scope: 'project', agents: ['windsurf'], packs: ['wigolo-search'], cwd: tmpCwd });
    expect(plan.notes.some((n) => /digest/.test(n))).toBe(true);
  });
});
