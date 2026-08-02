import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

// Detection comes from the AGENT REGISTRY (detectInstalledHandlers). We mock
// only that seam — everything else (planner/executor/list + the real handler
// list, incl. cline) runs for real against a temp project (cwd), temp HOME,
// and temp data dir. Real handler detect() probes PATH binaries (`which`), so
// deterministic tests control detection via the mock; the cline auto-detect
// test swaps the REAL implementation back in against the mocked HOME.
const { detectHandlersMock, homeRef } = vi.hoisted(() => ({
  detectHandlersMock: vi.fn(),
  homeRef: { dir: '' },
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homeRef.dir || actual.homedir() };
});

vi.mock('../../../src/cli/agents/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/agents/registry.js')>();
  return { ...actual, detectInstalledHandlers: detectHandlersMock };
});

import { agentHandlers } from '../../../src/cli/agents/registry.js';

function withDetected(ids: string[]): void {
  detectHandlersMock.mockImplementation(() =>
    agentHandlers.filter((h) => ids.includes(h.id)),
  );
}

/** Route detection through the REAL registry detect() implementations. */
async function withRealDetection(): Promise<void> {
  const actual = await vi.importActual<typeof import('../../../src/cli/agents/registry.js')>(
    '../../../src/cli/agents/registry.js',
  );
  detectHandlersMock.mockImplementation(actual.detectInstalledHandlers);
}

/** Hash the entire file tree under a dir → detects any fs mutation. */
function hashTree(root: string): string {
  if (!existsSync(root)) return 'ABSENT';
  const h = createHash('sha256');
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      const rel = relative(root, full).split(sep).join('/');
      if (st.isDirectory()) {
        h.update(`D:${rel}\n`);
        walk(full);
      } else {
        h.update(`F:${rel}:${readFileSync(full, 'utf-8')}\n`);
      }
    }
  };
  walk(root);
  return h.digest('hex');
}

let tmpProject: string;
let tmpData: string;
let tmpHome: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let stdoutLines: string[];
let stderrLines: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

let runSkills: (args: string[]) => Promise<number>;

beforeEach(async () => {
  detectHandlersMock.mockReset();
  withDetected([]);

  tmpProject = mkdtempSync(join(tmpdir(), 'wg-skills-proj-'));
  tmpData = mkdtempSync(join(tmpdir(), 'wg-skills-data-'));
  tmpHome = mkdtempSync(join(tmpdir(), 'wg-skills-home-'));
  homeRef.dir = tmpHome;
  process.env.WIGOLO_DATA_DIR = tmpData;

  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpProject);

  stdoutLines = [];
  stderrLines = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  });

  // Dynamic import AFTER mocks are installed.
  ({ runSkills } = await import('../../../src/cli/skills.js'));
});

afterEach(() => {
  cwdSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  delete process.env.WIGOLO_DATA_DIR;
  homeRef.dir = '';
  rmSync(tmpProject, { recursive: true, force: true });
  rmSync(tmpData, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

function out(): string {
  return stdoutLines.join('');
}
function err(): string {
  return stderrLines.join('');
}
/** Parse the single JSON envelope line off stdout. */
function jsonEnvelope(): {
  status: string;
  scope: string;
  actions: Array<{ agents: string[]; packs: string[]; path: string; status: string; reason?: string }>;
  summary: string;
} {
  const line = stdoutLines.map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  if (!line) throw new Error(`no JSON envelope in stdout: ${out()}`);
  return JSON.parse(line);
}

describe('runSkills — usage & argument validation', () => {
  it('returns 2 with usage when no subcommand given', async () => {
    const code = await runSkills([]);
    expect(code).toBe(2);
    expect(err()).toContain('Usage: wigolo skills');
  });

  it('returns 2 on an unknown subcommand', async () => {
    const code = await runSkills(['frobnicate']);
    expect(code).toBe(2);
    expect(err()).toContain('Unknown subcommand: frobnicate');
  });

  it('--help returns 0 and prints usage', async () => {
    const code = await runSkills(['--help']);
    expect(code).toBe(0);
    expect(out()).toContain('Usage: wigolo skills');
  });
});

describe('runSkills — pack validation', () => {
  it('unknown pack → exit 2 + lists valid packs', async () => {
    withDetected(['claude-code']);
    const code = await runSkills(['add', 'not-a-real-pack']);
    expect(code).toBe(2);
    expect(err()).toContain('Unknown pack(s): not-a-real-pack');
    expect(err()).toContain('valid packs:');
    expect(err()).toContain('wigolo-search');
  });
});

describe('runSkills — agent validation', () => {
  it('--agent vscode (registered but no skills) → exit 2 on add + supported list', async () => {
    const code = await runSkills(['add', '--agent', 'vscode']);
    expect(code).toBe(2);
    expect(err()).toContain('Unsupported agent(s): vscode');
    expect(err()).toContain('cline');
  });

  it('--agent bogus (unknown id) → exit 2 + supported list', async () => {
    const code = await runSkills(['add', '--agent', 'bogus']);
    expect(code).toBe(2);
    expect(err()).toContain('Unsupported agent(s): bogus');
  });

  it('--agent cline produces a cline-target plan (dry-run)', async () => {
    const code = await runSkills(['add', 'wigolo-search', '--agent', 'cline', '--dry-run', '--json']);
    expect(code).toBe(0);
    const env = jsonEnvelope();
    // The cline skill-dirs target is .cline/skills/<pack>.
    expect(env.actions.some((a) => a.agents.includes('cline'))).toBe(true);
    expect(env.actions.some((a) => a.path.includes('.cline/skills'))).toBe(true);
  });

  it('supported-but-UNDETECTED agent proceeds when named explicitly', async () => {
    // Nothing detected, but cline explicitly targeted → still plans.
    withDetected([]);
    const code = await runSkills(['add', 'wigolo-search', '--agent', 'cline', '--dry-run']);
    expect(code).toBe(0);
    expect(out()).toContain('cline');
  });
});

describe('runSkills — detection default', () => {
  it('none detected → exit 0 with actionable note (not an error)', async () => {
    withDetected([]);
    const code = await runSkills(['add', 'wigolo-search']);
    expect(code).toBe(0);
    expect(err()).toContain('No supported coding agents detected');
    expect(err()).toContain('--agent');
  });

  it('none detected --json → status ok, exit 0', async () => {
    withDetected([]);
    const code = await runSkills(['add', '--json']);
    expect(code).toBe(0);
    expect(jsonEnvelope().status).toBe('ok');
  });

  it('detected agents are used as the default target', async () => {
    withDetected(['claude-code']);
    const code = await runSkills(['add', 'wigolo-search', '--dry-run', '--json']);
    expect(code).toBe(0);
    const env = jsonEnvelope();
    expect(env.actions.some((a) => a.agents.includes('claude-code'))).toBe(true);
  });

  it('a ~/.cline dir in HOME auto-detects cline into the default plan (real registry detect)', async () => {
    // Real registry detection against the mocked HOME: cline's handler probes
    // ~/.cline — no --agent flag needed. This is the reason detection MUST go
    // through the agent registry (the tui registry has no cline entry at all).
    await withRealDetection();
    mkdirSync(join(tmpHome, '.cline'), { recursive: true });
    const code = await runSkills(['add', 'wigolo-search', '--dry-run', '--json']);
    expect(code).toBe(0);
    const env = jsonEnvelope();
    expect(env.actions.some((a) => a.agents.includes('cline'))).toBe(true);
    expect(env.actions.some((a) => a.path.includes('.cline/skills'))).toBe(true);
  });
});

describe('runSkills — dry-run never mutates the filesystem', () => {
  it('add --dry-run leaves the project tree byte-identical', async () => {
    withDetected(['claude-code']);
    const before = hashTree(tmpProject);
    const code = await runSkills(['add', 'wigolo-search', '--dry-run']);
    const after = hashTree(tmpProject);
    expect(code).toBe(0);
    expect(after).toBe(before);
    // Also nothing landed in the target dir.
    expect(existsSync(join(tmpProject, '.claude', 'skills'))).toBe(false);
  });
});

describe('runSkills — add executes and is idempotent', () => {
  it('add writes pack files then reports unchanged on re-run', async () => {
    withDetected(['claude-code']);
    const first = await runSkills(['add', 'wigolo-search']);
    expect(first).toBe(0);
    expect(existsSync(join(tmpProject, '.claude', 'skills', 'wigolo-search', 'SKILL.md'))).toBe(true);

    stdoutLines = [];
    stderrLines = [];
    const second = await runSkills(['add', 'wigolo-search', '--json']);
    expect(second).toBe(0);
    const env = jsonEnvelope();
    // Second run: nothing new written.
    expect(env.actions.every((a) => a.status === 'unchanged')).toBe(true);
  });
});

describe('runSkills — list', () => {
  it('lists per-agent state without exit 2 for registered-no-skills agents', async () => {
    const code = await runSkills(['list', '--agent', 'claude-code,vscode', '--json']);
    expect(code).toBe(0);
    const env = jsonEnvelope();
    expect(env.actions.some((a) => a.agents.includes('vscode') && a.status === 'not supported')).toBe(true);
    expect(env.actions.some((a) => a.agents.includes('claude-code'))).toBe(true);
  });

  it('list human output rows a no-skills agent as "not supported"', async () => {
    const code = await runSkills(['list', '--agent', 'zed']);
    expect(code).toBe(0);
    expect(out()).toContain('not supported');
  });

  it('list reflects an installed pack', async () => {
    withDetected(['claude-code']);
    await runSkills(['add', 'wigolo-search']);
    stdoutLines = [];
    stderrLines = [];
    const code = await runSkills(['list', 'wigolo-search', '--agent', 'claude-code', '--json']);
    expect(code).toBe(0);
    const env = jsonEnvelope();
    const row = env.actions.find((a) => a.agents.includes('claude-code') && a.packs.includes('wigolo-search'));
    expect(row?.status).toBe('installed');
  });
});

describe('runSkills — remove', () => {
  it('remove deletes an installed pack and reports it', async () => {
    withDetected(['claude-code']);
    await runSkills(['add', 'wigolo-search']);
    expect(existsSync(join(tmpProject, '.claude', 'skills', 'wigolo-search'))).toBe(true);

    stdoutLines = [];
    stderrLines = [];
    const code = await runSkills(['remove', 'wigolo-search', '--agent', 'claude-code']);
    expect(code).toBe(0);
    expect(existsSync(join(tmpProject, '.claude', 'skills', 'wigolo-search'))).toBe(false);
  });

  it('remove --dry-run does not mutate the filesystem', async () => {
    withDetected(['claude-code']);
    await runSkills(['add', 'wigolo-search']);
    const before = hashTree(tmpProject);
    stdoutLines = [];
    stderrLines = [];
    const code = await runSkills(['remove', 'wigolo-search', '--agent', 'claude-code', '--dry-run']);
    expect(code).toBe(0);
    expect(hashTree(tmpProject)).toBe(before);
    expect(existsSync(join(tmpProject, '.claude', 'skills', 'wigolo-search'))).toBe(true);
  });
});

describe('runSkills — --json purity (F7): stdout is ONE JSON document', () => {
  it('add --dry-run --json emits exactly one JSON object on stdout, no human text', async () => {
    withDetected(['claude-code']);
    const code = await runSkills(['add', 'wigolo-search', '--dry-run', '--json']);
    expect(code).toBe(0);
    // The ENTIRE stdout must parse as a single JSON document.
    const full = out().trim();
    expect(() => JSON.parse(full)).not.toThrow();
    const parsed = JSON.parse(full);
    expect(parsed.status).toBe('ok');
    // No stray human lines leaked before/after.
    expect(full.startsWith('{')).toBe(true);
    expect(full.endsWith('}')).toBe(true);
  });

  it('list --json emits exactly one JSON document on stdout', async () => {
    withDetected(['claude-code']);
    const code = await runSkills(['list', '--agent', 'claude-code', '--json']);
    expect(code).toBe(0);
    const full = out().trim();
    expect(() => JSON.parse(full)).not.toThrow();
    expect(full.startsWith('{') && full.endsWith('}')).toBe(true);
  });

  it('remove --dry-run --json emits exactly one JSON document on stdout', async () => {
    withDetected(['claude-code']);
    await runSkills(['add', 'wigolo-search']);
    stdoutLines = [];
    stderrLines = [];
    const code = await runSkills(['remove', 'wigolo-search', '--agent', 'claude-code', '--dry-run', '--json']);
    expect(code).toBe(0);
    const full = out().trim();
    expect(() => JSON.parse(full)).not.toThrow();
    expect(full.startsWith('{') && full.endsWith('}')).toBe(true);
  });
});

describe('runSkills — remove --dry-run per-file preview (F8)', () => {
  it('preview shows remove actions for an installed pack, fs untouched', async () => {
    withDetected(['claude-code']);
    await runSkills(['add', 'wigolo-search']);
    stdoutLines = [];
    stderrLines = [];
    const code = await runSkills(['remove', 'wigolo-search', '--agent', 'claude-code', '--dry-run', '--json']);
    expect(code).toBe(0);
    const env = jsonEnvelope();
    expect(env.actions.some((a) => a.status === 'remove')).toBe(true);
    expect(existsSync(join(tmpProject, '.claude', 'skills', 'wigolo-search', 'SKILL.md'))).toBe(true);
  });

  it('preview shows refuse for a user-modified file and exits 2, fs untouched', async () => {
    withDetected(['claude-code']);
    await runSkills(['add', 'wigolo-search']);
    const f = join(tmpProject, '.claude', 'skills', 'wigolo-search', 'SKILL.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(f, 'user hand edit\n', 'utf-8');
    const before = hashTree(tmpProject);
    stdoutLines = [];
    stderrLines = [];
    const code = await runSkills(['remove', 'wigolo-search', '--agent', 'claude-code', '--dry-run', '--json']);
    expect(code).toBe(2);
    const env = jsonEnvelope();
    expect(env.actions.some((a) => a.status === 'refuse')).toBe(true);
    expect(hashTree(tmpProject)).toBe(before); // nothing changed on disk
  });
});

describe('runSkills — --json envelope on refusal paths', () => {
  it('--json on a usage error carries status:error, exit 2', async () => {
    const code = await runSkills(['add', '--agent', 'vscode', '--json']);
    expect(code).toBe(2);
    const env = jsonEnvelope();
    expect(env.status).toBe('error');
    expect(env.summary).toContain('vscode');
  });

  it('--json on unknown pack carries status:error, exit 2', async () => {
    withDetected(['claude-code']);
    const code = await runSkills(['add', 'nope', '--json']);
    expect(code).toBe(2);
    expect(jsonEnvelope().status).toBe('error');
  });

  it('--json on missing subcommand carries status:error, exit 2', async () => {
    const code = await runSkills(['--json']);
    expect(code).toBe(2);
    expect(jsonEnvelope().status).toBe('error');
  });

  it('a modified-file refusal surfaces status:error via engine (exit 2)', async () => {
    withDetected(['claude-code']);
    await runSkills(['add', 'wigolo-search']);
    // Tamper with an installed file so a re-add refuses (user-modified).
    const f = join(tmpProject, '.claude', 'skills', 'wigolo-search', 'SKILL.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(f, 'user hand-edit\n', 'utf-8');

    stdoutLines = [];
    stderrLines = [];
    const code = await runSkills(['add', 'wigolo-search', '--agent', 'claude-code', '--json']);
    expect(code).toBe(2);
    const env = jsonEnvelope();
    expect(env.status).toBe('error');
    expect(env.actions.some((a) => a.status === 'refuse')).toBe(true);
  });

  it('--force overrides a modified-file refusal (exit 0)', async () => {
    withDetected(['claude-code']);
    await runSkills(['add', 'wigolo-search']);
    const f = join(tmpProject, '.claude', 'skills', 'wigolo-search', 'SKILL.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(f, 'user hand-edit\n', 'utf-8');

    stdoutLines = [];
    stderrLines = [];
    const code = await runSkills(['add', 'wigolo-search', '--agent', 'claude-code', '--force', '--json']);
    expect(code).toBe(0);
    expect(jsonEnvelope().status).toBe('ok');
  });
});
