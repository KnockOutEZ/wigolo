import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

let tmpHome: string;
let tmpData: string;
let tmpCwd: string;

// Controllable writeFileSync: defaults to pass-through; a test can install a
// custom impl to inject failures. ESM export spies aren't configurable, so we
// mock node:fs and route writeFileSync through this mutable hook.
let writeHook: ((p: unknown, data: unknown, opts: unknown) => void) | null = null;
const writeCalls: unknown[][] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (p: unknown, data: unknown, opts: unknown) => {
      writeCalls.push([p, data, opts]);
      if (writeHook) return writeHook(p, data, opts);
      return actual.writeFileSync(p as string, data as string, opts as never);
    },
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

vi.mock('../../../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: tmpData })),
}));

async function loadExec() {
  return import('../../../../../src/cli/agents/skills/executor.js');
}
async function loadPlan() {
  return import('../../../../../src/cli/agents/skills/planner.js');
}
async function loadCat() {
  return import('../../../../../src/cli/agents/skills/catalog.js');
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `wigolo-exec-home-${stamp}`);
  tmpData = join(tmpdir(), `wigolo-exec-data-${stamp}`);
  tmpCwd = join(tmpdir(), `wigolo-exec-cwd-${stamp}`);
  for (const d of [tmpHome, tmpData, tmpCwd]) mkdirSync(d, { recursive: true });
  writeHook = null;
  writeCalls.length = 0;
  vi.resetModules();
});

afterEach(() => {
  writeHook = null;
  for (const d of [tmpHome, tmpData, tmpCwd]) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('applySkillsPlan — fresh install', () => {
  it('writes all pack files and records a receipt', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan } = await loadExec();
    const plan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    const res = applySkillsPlan(plan);
    const skillMd = join(tmpHome, '.claude', 'skills', 'wigolo', 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);
    expect(res.written.length).toBeGreaterThan(0);
    expect(existsSync(join(tmpData, 'skills', 'receipts.json'))).toBe(true);
  });

  it('re-apply of an unchanged install performs ZERO write calls', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd }));

    // Re-plan (now sees receipt + on-disk match) → unchanged, no writes.
    const plan2 = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    expect(plan2.actions.find((a) => a.packs[0] === 'wigolo')!.status).toBe('unchanged');
    writeCalls.length = 0;
    applySkillsPlan(plan2);
    const skillWrites = writeCalls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes(join('skills', 'wigolo')),
    );
    expect(skillWrites).toEqual([]);
  });
});

describe('applySkillsPlan — rollback injection', () => {
  it('mid-apply write failure rolls back files created THIS run, receipt not written', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan } = await loadExec();
    const plan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });

    const packDir = join(tmpHome, '.claude', 'skills', 'wigolo');
    const { writeFileSync: realWrite } = await vi.importActual<typeof import('node:fs')>('node:fs');
    let managedWrites = 0;
    writeHook = (p, data, opts) => {
      const path = String(p);
      const isManaged = path.startsWith(packDir) && !path.includes('.tmp-');
      if (isManaged) {
        managedWrites += 1;
        if (managedWrites === 2) throw new Error('disk full');
      }
      return realWrite(p as string, data as string, opts as never);
    };

    expect(() => applySkillsPlan(plan)).toThrow(/disk full/);
    writeHook = null;

    // First created file must have been rolled back (unlinked); an empty pack
    // dir may also have been pruned.
    const written = existsSync(packDir)
      ? readdirSync(packDir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length
      : 0;
    expect(written).toBe(0);

    // No receipt should have been written (receipt is LAST, after all files).
    const rcpt = join(tmpData, 'skills', 'receipts.json');
    const store = existsSync(rcpt) ? JSON.parse(readFileSync(rcpt, 'utf-8')) : {};
    const hasWigolo = Object.values(store).some((e) => {
      const packs = (e as { packs?: Record<string, unknown> }).packs;
      return packs && 'wigolo' in packs;
    });
    expect(hasWigolo).toBe(false);
  });
});

describe('removeSkills — modified refusal + survivors', () => {
  it('refuses to remove a user-modified pack file without force', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, removeSkills } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd }));

    const skillMd = join(tmpHome, '.claude', 'skills', 'wigolo', 'SKILL.md');
    writeFileSync(skillMd, 'USER EDITED THIS', 'utf-8');

    const res = removeSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    expect(res.refused.length).toBeGreaterThan(0);
    expect(existsSync(skillMd)).toBe(true); // not deleted
  });

  it('force removes managed files but a user notes.md survives + dir kept', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, removeSkills } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd }));

    const packDir = join(tmpHome, '.claude', 'skills', 'wigolo');
    const notes = join(packDir, 'notes.md');
    writeFileSync(notes, 'my private notes', 'utf-8');
    // Also modify a managed file so force is exercised.
    writeFileSync(join(packDir, 'SKILL.md'), 'edited', 'utf-8');

    const res = removeSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd, force: true });
    expect(existsSync(notes)).toBe(true); // user file untouched
    expect(existsSync(packDir)).toBe(true); // dir kept because notes survives
    expect(res.notices.some((n) => /survive/.test(n))).toBe(true);
  });
});

describe('removeSkills — shared-path two-agent sequence', () => {
  it('remove codex ⇒ files intact + receipt decremented; remove cursor ⇒ files gone', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, removeSkills } = await loadExec();
    // Install codex + cursor to the shared .agents/skills base.
    applySkillsPlan(planSkills({ scope: 'project', agents: ['codex', 'cursor'], packs: ['wigolo'], cwd: tmpCwd }));
    const skillMd = join(tmpCwd, '.agents', 'skills', 'wigolo', 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);

    // Remove codex — shared receipt lists [codex, cursor] → decrement only.
    removeSkills({ scope: 'project', agents: ['codex'], packs: ['wigolo'], cwd: tmpCwd });
    expect(existsSync(skillMd)).toBe(true);

    // Remove cursor — now sole owner → files deleted.
    removeSkills({ scope: 'project', agents: ['cursor'], packs: ['wigolo'], cwd: tmpCwd });
    expect(existsSync(skillMd)).toBe(false);
  });
});

describe('removeSkills — structural bounds', () => {
  it('refuses a forged receipt key outside bounds and never deletes', async () => {
    const { removeSkills } = await loadExec();
    // Forge a receipt claiming an out-of-bounds path.
    const evilDir = join(tmpHome, 'evil');
    mkdirSync(evilDir, { recursive: true });
    const victim = join(evilDir, 'victim.txt');
    writeFileSync(victim, 'do not delete me', 'utf-8');
    mkdirSync(join(tmpData, 'skills'), { recursive: true });
    writeFileSync(
      join(tmpData, 'skills', 'receipts.json'),
      JSON.stringify({
        [evilDir]: {
          scope: 'global', agents: ['claude-code'],
          packs: { wigolo: { version: '1', files: { 'victim.txt': 'x' } } },
          installedAt: 'now',
        },
      }),
      'utf-8',
    );
    // removeAllSkills should bounds-refuse this key.
    const { removeAllSkills } = await loadExec();
    const res = removeAllSkills({ cwd: tmpCwd });
    expect(existsSync(victim)).toBe(true);
    expect(res.refused.some((r) => /bounds/.test(r.reason ?? ''))).toBe(true);
    void removeSkills;
  });
});

describe('removeAllSkills — legacy-bytes sweep with EMPTY receipts', () => {
  it('removes canonical-byte pack files even with no receipt store', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, removeAllSkills } = await loadExec();
    // Install then wipe the receipt store — simulating a legacy/receiptless install.
    applySkillsPlan(planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd }));
    rmSync(join(tmpData, 'skills', 'receipts.json'), { force: true });

    const skillMd = join(tmpHome, '.claude', 'skills', 'wigolo', 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);

    removeAllSkills({ cwd: tmpCwd });
    // Canonical bytes are recognized via catalog hash → safe to remove.
    expect(existsSync(skillMd)).toBe(false);
  });
});

describe('applySkillsPlan — .wigolo-bak never deleted', () => {
  it('leaves a pre-existing .wigolo-bak sibling untouched on windsurf global merge', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan } = await loadExec();
    const dir = join(tmpHome, '.codeium', 'windsurf', 'memories');
    mkdirSync(dir, { recursive: true });
    const bak = join(dir, 'global_rules.md.wigolo-bak');
    writeFileSync(bak, 'backup content', 'utf-8');
    applySkillsPlan(planSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd }));
    expect(existsSync(bak)).toBe(true);
    expect(readFileSync(bak, 'utf-8')).toBe('backup content');
  });
});

describe('listSkills', () => {
  it('reports installed after a fresh install', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, listSkills } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd }));
    const list = listSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    expect(list.find((e) => e.pack === 'wigolo')!.state).toBe('installed');
  });

  it('reports modified when a managed file is edited', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, listSkills } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd }));
    writeFileSync(join(tmpHome, '.claude', 'skills', 'wigolo', 'SKILL.md'), 'edited', 'utf-8');
    const list = listSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    expect(list.find((e) => e.pack === 'wigolo')!.state).toBe('modified');
  });

  it('reports absent when nothing installed', async () => {
    const { listSkills } = await loadExec();
    const list = listSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    expect(list.find((e) => e.pack === 'wigolo')!.state).toBe('absent');
  });

  it('NEVER writes (pure)', async () => {
    const { listSkills } = await loadExec();
    writeCalls.length = 0;
    listSkills({ scope: 'global', agents: ['claude-code'], cwd: tmpCwd });
    expect(writeCalls).toEqual([]);
  });

  // F15 — list states never previously asserted.
  it('reports adopted when canonical bytes sit with no receipt', async () => {
    const { listSkills } = await loadExec();
    const { loadPack } = await loadCat();
    const pack = loadPack('wigolo-search');
    const dir = join(tmpHome, '.claude', 'skills', 'wigolo-search');
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(pack.files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content, 'utf-8');
    }
    const list = listSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo-search'], cwd: tmpCwd });
    expect(list.find((e) => e.pack === 'wigolo-search')!.state).toBe('adopted');
  });

  it('reports stale when a receipt exists but the pack dir is gone', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, listSkills } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd }));
    // Remove the pack dir on disk but leave the receipt.
    rmSync(join(tmpHome, '.claude', 'skills', 'wigolo'), { recursive: true, force: true });
    const list = listSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    expect(list.find((e) => e.pack === 'wigolo')!.state).toBe('stale');
  });

  it('reports managed-externally when the pack dir is a symlink', async () => {
    const { listSkills } = await loadExec();
    const skillsBase = join(tmpHome, '.claude', 'skills');
    mkdirSync(skillsBase, { recursive: true });
    const external = join(tmpHome, 'external');
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(skillsBase, 'wigolo'));
    const list = listSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    expect(list.find((e) => e.pack === 'wigolo')!.state).toBe('managed-externally');
  });

  it('reports outdated when the receipt version drifts and canonical differs', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, listSkills } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd }));
    // Rewrite the receipt with a bogus old version so version-drift trips, and
    // edit an on-disk file to a byte state that still hash-matches the receipt
    // but differs from canonical (simulate: point receipt hash at current disk,
    // then tweak the on-disk bytes AND the receipt hash so onDisk===receipt but
    // onDisk!==canonical). Simplest: set receipt version old + overwrite a file
    // with content whose hash we also store in the receipt.
    const rcptPath = join(tmpData, 'skills', 'receipts.json');
    const store = JSON.parse(readFileSync(rcptPath, 'utf-8'));
    const key = Object.keys(store)[0];
    const drifted = 'drifted-but-tracked\n';
    const driftedHash = createHash('sha256').update(drifted, 'utf-8').digest('hex');
    store[key].packs.wigolo.version = '0.0.1-old';
    store[key].packs.wigolo.files['SKILL.md'] = driftedHash;
    writeFileSync(rcptPath, JSON.stringify(store), 'utf-8');
    writeFileSync(join(tmpHome, '.claude', 'skills', 'wigolo', 'SKILL.md'), drifted, 'utf-8');
    const list = listSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    expect(list.find((e) => e.pack === 'wigolo')!.state).toBe('outdated');
  });
});

// F1 — executor must never write through a symlink; force replaces the LINK.
describe('applySkillsPlan — symlink write-path guard (F1)', () => {
  it('force + symlinked pack dir replaces the link with a real dir; target tree untouched', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan } = await loadExec();
    const skillsBase = join(tmpHome, '.claude', 'skills');
    mkdirSync(skillsBase, { recursive: true });
    // The symlink target holds a sentinel that must survive.
    const target = join(tmpHome, 'external-target');
    mkdirSync(target, { recursive: true });
    const sentinel = join(target, 'sentinel.txt');
    writeFileSync(sentinel, 'do not touch', 'utf-8');
    const packLink = join(skillsBase, 'wigolo');
    symlinkSync(target, packLink);

    const plan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd, force: true });
    applySkillsPlan(plan);

    // The link is gone; a real dir now sits there with the pack's SKILL.md.
    expect(lstatSync(packLink).isSymbolicLink()).toBe(false);
    expect(lstatSync(packLink).isDirectory()).toBe(true);
    expect(existsSync(join(packLink, 'SKILL.md'))).toBe(true);
    // The link TARGET tree is untouched.
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf-8')).toBe('do not touch');
  });

  it('a symlink LEAF planted AFTER planning (TOCTOU) is refused; target untouched', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan } = await loadExec();
    // Plan on a clean fs — every file resolves to create.
    const plan = planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });

    // Now plant a symlink where SKILL.md would be written.
    const packDir = join(tmpHome, '.claude', 'skills', 'wigolo');
    mkdirSync(packDir, { recursive: true });
    const victim = join(tmpHome, 'victim.txt');
    writeFileSync(victim, 'ORIGINAL', 'utf-8');
    symlinkSync(victim, join(packDir, 'SKILL.md'));

    const res = applySkillsPlan(plan);
    // The write through the link was refused; victim content is intact.
    expect(readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(lstatSync(join(packDir, 'SKILL.md')).isSymbolicLink()).toBe(true);
    expect(res.refused.some((r) => /symlink appeared|TOCTOU|write through/i.test(r.reason ?? ''))).toBe(true);
  });

  it('force + symlinked owned windsurf project file replaces the link; target untouched', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan } = await loadExec();
    const rulesDir = join(tmpCwd, '.windsurf', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    const target = join(tmpCwd, 'external-rules.md');
    writeFileSync(target, 'USER RULES', 'utf-8');
    const link = join(rulesDir, 'wigolo.md');
    symlinkSync(target, link);

    const plan = planSkills({ scope: 'project', agents: ['windsurf'], cwd: tmpCwd, force: true });
    applySkillsPlan(plan);

    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe('USER RULES'); // target untouched
  });
});

// F2 — remove for a non-member agent must NOT delete shared files.
describe('removeSkills — non-member removal is a no-op (F2)', () => {
  it('receipt owned by codex; remove --agent cursor leaves files + receipt intact', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, removeSkills } = await loadExec();
    // Install ONLY codex into the shared .agents/skills base.
    applySkillsPlan(planSkills({ scope: 'project', agents: ['codex'], packs: ['wigolo'], cwd: tmpCwd }));
    const skillMd = join(tmpCwd, '.agents', 'skills', 'wigolo', 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);

    const rcptPath = join(tmpData, 'skills', 'receipts.json');
    const before = readFileSync(rcptPath, 'utf-8');

    // Remove for cursor — NOT an owner of this path.
    const res = removeSkills({ scope: 'project', agents: ['cursor'], packs: ['wigolo'], cwd: tmpCwd });

    expect(existsSync(skillMd)).toBe(true); // files survive
    expect(readFileSync(rcptPath, 'utf-8')).toBe(before); // receipt untouched
    expect(res.removed).toEqual([]);
    expect(res.notices.some((n) => /owned by: codex|not removed/i.test(n))).toBe(true);
  });
});

// F3 — a per-pack remove must not strip the windsurf digest.
describe('removeSkills — per-pack remove leaves windsurf digest (F3)', () => {
  it('remove wigolo-search does NOT touch the windsurf project rules', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, removeSkills } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'project', agents: ['claude-code'], packs: ['wigolo-search'], cwd: tmpCwd }));
    applySkillsPlan(planSkills({ scope: 'project', agents: ['windsurf'], cwd: tmpCwd }));
    const rules = join(tmpCwd, '.windsurf', 'rules', 'wigolo.md');
    expect(existsSync(rules)).toBe(true);

    removeSkills({ scope: 'project', agents: ['claude-code', 'windsurf'], packs: ['wigolo-search'], cwd: tmpCwd });
    expect(existsSync(rules)).toBe(true); // digest untouched
  });

  it('remove with NO packs (all) DOES strip the windsurf digest', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, removeSkills } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'project', agents: ['windsurf'], cwd: tmpCwd }));
    const rules = join(tmpCwd, '.windsurf', 'rules', 'wigolo.md');
    expect(existsSync(rules)).toBe(true);

    removeSkills({ scope: 'project', agents: ['windsurf'], cwd: tmpCwd });
    expect(existsSync(rules)).toBe(false);
  });
});

// F4 — windsurf-global list state.
describe('listSkills — windsurf global (F4)', () => {
  it('fresh windsurf global install with a user preamble lists installed (not modified)', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, listSkills } = await loadExec();
    const dir = join(tmpHome, '.codeium', 'windsurf', 'memories');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'global_rules.md'), '# my rules\nkeep this\n', 'utf-8');
    applySkillsPlan(planSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd }));
    const list = listSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd });
    expect(list.find((e) => e.agent === 'windsurf')!.state).toBe('installed');
  });

  it('global_rules.md with NO wigolo block and no receipt lists absent (not adopted)', async () => {
    const { listSkills } = await loadExec();
    const dir = join(tmpHome, '.codeium', 'windsurf', 'memories');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'global_rules.md'), '# just my own rules\n', 'utf-8');
    const list = listSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd });
    expect(list.find((e) => e.agent === 'windsurf')!.state).toBe('absent');
  });
});

// F6 — windsurf removal at the engine level.
describe('removeSkills / removeAllSkills — windsurf removal (F6)', () => {
  it('global block stripped; user preamble preserved; file kept', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, removeSkills } = await loadExec();
    const dir = join(tmpHome, '.codeium', 'windsurf', 'memories');
    mkdirSync(dir, { recursive: true });
    const gr = join(dir, 'global_rules.md');
    writeFileSync(gr, '# personal\nkeep me\n', 'utf-8');
    applySkillsPlan(planSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd }));
    expect(readFileSync(gr, 'utf-8')).toContain('<!-- wigolo:start');

    removeSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd });
    const after = readFileSync(gr, 'utf-8');
    expect(after).not.toContain('<!-- wigolo:start');
    expect(after).toContain('keep me'); // preamble survives
  });

  it('global block-only file is deleted when the block was its only content', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, removeSkills } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd }));
    const gr = join(tmpHome, '.codeium', 'windsurf', 'memories', 'global_rules.md');
    expect(existsSync(gr)).toBe(true);
    removeSkills({ scope: 'global', agents: ['windsurf'], cwd: tmpCwd });
    expect(existsSync(gr)).toBe(false);
  });

  it('project owned file deleted on remove', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, removeSkills } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'project', agents: ['windsurf'], cwd: tmpCwd }));
    const rules = join(tmpCwd, '.windsurf', 'rules', 'wigolo.md');
    expect(existsSync(rules)).toBe(true);
    removeSkills({ scope: 'project', agents: ['windsurf'], cwd: tmpCwd });
    expect(existsSync(rules)).toBe(false);
  });

  it('user-modified project rules file is refused (no force)', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, removeSkills } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'project', agents: ['windsurf'], cwd: tmpCwd }));
    const rules = join(tmpCwd, '.windsurf', 'rules', 'wigolo.md');
    writeFileSync(rules, 'USER HAND EDIT', 'utf-8');
    const res = removeSkills({ scope: 'project', agents: ['windsurf'], cwd: tmpCwd });
    expect(existsSync(rules)).toBe(true);
    expect(res.refused.some((r) => /user-modified/i.test(r.reason ?? ''))).toBe(true);
  });
});

// F8 — engine-level remove dry-run.
describe('planRemove — pure preview (F8)', () => {
  function treeHash(dir: string): string {
    const h = createHash('sha256');
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const name of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(d, name.name);
        if (name.isDirectory()) { h.update(`D:${full}\n`); walk(full); }
        else h.update(`F:${full}:${readFileSync(full, 'utf-8')}\n`);
      }
    };
    walk(dir);
    return h.digest('hex');
  }

  it('dry-run remove reports remove actions but mutates NOTHING', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, planRemove } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd }));
    const beforeTree = treeHash(join(tmpHome, '.claude'));
    const beforeRcpt = readFileSync(join(tmpData, 'skills', 'receipts.json'), 'utf-8');

    const plan = planRemove({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    expect(plan.actions.some((a) => a.status === 'remove')).toBe(true);
    expect(treeHash(join(tmpHome, '.claude'))).toBe(beforeTree);
    expect(readFileSync(join(tmpData, 'skills', 'receipts.json'), 'utf-8')).toBe(beforeRcpt);
  });

  it('dry-run remove on a user-modified file shows refuse and touches nothing', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan, planRemove } = await loadExec();
    applySkillsPlan(planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd }));
    const skillMd = join(tmpHome, '.claude', 'skills', 'wigolo', 'SKILL.md');
    writeFileSync(skillMd, 'USER EDIT', 'utf-8');
    const beforeTree = treeHash(join(tmpHome, '.claude'));

    const plan = planRemove({ scope: 'global', agents: ['claude-code'], packs: ['wigolo'], cwd: tmpCwd });
    expect(plan.actions.some((a) => a.status === 'refuse')).toBe(true);
    expect(existsSync(skillMd)).toBe(true);
    expect(treeHash(join(tmpHome, '.claude'))).toBe(beforeTree);
  });
});

// F16 — adopted-flag persistence.
describe('recordReceipt — adopted flag persists (F16)', () => {
  it('an adopt apply writes adopted:true into the receipt entry', async () => {
    const { planSkills } = await loadPlan();
    const { applySkillsPlan } = await loadExec();
    const { loadPack } = await loadCat();
    const pack = loadPack('wigolo-search');
    const dir = join(tmpHome, '.claude', 'skills', 'wigolo-search');
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(pack.files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content, 'utf-8');
    }
    applySkillsPlan(planSkills({ scope: 'global', agents: ['claude-code'], packs: ['wigolo-search'], cwd: tmpCwd }));
    const store = JSON.parse(readFileSync(join(tmpData, 'skills', 'receipts.json'), 'utf-8'));
    const entry = Object.values(store).find((e) => {
      const packs = (e as { packs?: Record<string, unknown> }).packs;
      return packs && 'wigolo-search' in packs;
    }) as { adopted?: boolean };
    expect(entry.adopted).toBe(true);
  });
});
