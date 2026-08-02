/**
 * Tests for runUninstall's cleanup guidance.
 *
 * Why: `wigolo uninstall` removes agent integrations but PRESERVES the data
 * dir. The cleanup guidance it prints must match how wigolo was installed:
 *  - npm/source layout: full cleanup is `rm -rf ~/.wigolo`.
 *  - curl|sh bootstrap layout (~/.wigolo/tool or ~/.wigolo/runtime present):
 *    "remove the tool" (bin/tool/runtime) must be distinguished from "wipe all
 *    data" (rm -rf ~/.wigolo, which ALSO deletes the tool). Conflating them
 *    would tell a bootstrap user their only cleanup option destroys the cache.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../../src/cli/agents/registry.js', () => ({
  detectInstalledHandlers: vi.fn(() => []),
}));

const { removeAllSkillsMock } = vi.hoisted(() => ({
  removeAllSkillsMock: vi.fn(() => ({ written: [], removed: [], refused: [], notices: [] })),
}));
vi.mock('../../../src/cli/agents/skills/index.js', () => ({
  removeAllSkills: removeAllSkillsMock,
}));

let dataDir: string;

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir })),
}));

import { runUninstall } from '../../../src/cli/uninstall.js';
import { detectInstalledHandlers } from '../../../src/cli/agents/registry.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'wigolo-uninstall-'));
  dataDir = join(tmpHome, '.wigolo');
  mkdirSync(dataDir, { recursive: true });
  vi.mocked(detectInstalledHandlers).mockReturnValue([]);
  vi.clearAllMocks();
  vi.mocked(detectInstalledHandlers).mockReturnValue([]);
  removeAllSkillsMock.mockReturnValue({ written: [], removed: [], refused: [], notices: [] });
});

afterEach(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

describe('runUninstall cleanup guidance', () => {
  it('npm/source layout: full cleanup is a single rm -rf of the data dir', async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await runUninstall([]);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('') + cap.stderr.join('');
    expect(code).toBe(0);
    expect(out).toContain('rm -rf');
    expect(out).toContain(dataDir);
    // No bootstrap layout present, so it must NOT mention the installer's
    // --uninstall flag or the tool/runtime split.
    expect(out).not.toContain('install.sh --uninstall');
  });

  it('bootstrap layout (tool/): distinguishes tool removal from data wipe', async () => {
    mkdirSync(join(dataDir, 'tool'), { recursive: true });
    mkdirSync(join(dataDir, 'bin'), { recursive: true });
    mkdirSync(join(dataDir, 'runtime'), { recursive: true });
    const cap = captureOutput();
    let code: number;
    try {
      code = await runUninstall([]);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('') + cap.stderr.join('');
    expect(code).toBe(0);
    // Must offer the tool-only removal path (installer's own uninstall).
    expect(out).toContain('install.sh --uninstall');
    // Must name the tool dirs so the user knows what "remove the tool" touches.
    expect(out).toContain(join(dataDir, 'tool'));
    // Must still offer full-wipe, and make clear it ALSO deletes the tool.
    expect(out).toContain('rm -rf');
    expect(out).toContain(dataDir);
  });

  it('bootstrap layout (runtime only): still triggers the split guidance', async () => {
    mkdirSync(join(dataDir, 'runtime'), { recursive: true });
    const cap = captureOutput();
    try {
      await runUninstall([]);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('') + cap.stderr.join('');
    expect(out).toContain('install.sh --uninstall');
  });

  it('runs the skills sweep even when NO agent handlers are detected (before the early return)', async () => {
    // The no-handlers early return must NOT skip the receipt-driven skills
    // sweep: skill packs can persist even when no agent binary is present.
    vi.mocked(detectInstalledHandlers).mockReturnValue([]);
    const cap = captureOutput();
    try {
      await runUninstall([]);
    } finally {
      cap.restore();
    }
    expect(removeAllSkillsMock).toHaveBeenCalledTimes(1);
  });

  it('reports removed/left skill counts in the output', async () => {
    removeAllSkillsMock.mockReturnValue({
      written: [],
      removed: ['/h/.claude/skills/wigolo/SKILL.md', '/h/.claude/skills/wigolo-search/SKILL.md'],
      refused: [{ path: '/h/.claude/skills/wigolo-fetch/SKILL.md' } as never],
      notices: [],
    });
    const cap = captureOutput();
    try {
      await runUninstall([]);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('') + cap.stderr.join('');
    expect(out).toContain('2 removed');
    expect(out).toContain('1 left');
  });

  it('--help documents the bootstrap layout distinction', async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await runUninstall(['--help']);
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('') + cap.stderr.join('');
    expect(code).toBe(0);
    expect(out).toContain('install.sh --uninstall');
    expect(out).toContain('rm -rf');
  });
});

describe('runUninstall --json', () => {
  it('requires --yes: --json without --yes errors and exits 1 without touching anything', async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await runUninstall(['--json']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    // Destructive consent gate — the sweep must NOT have run.
    expect(removeAllSkillsMock).not.toHaveBeenCalled();
    // Error surfaces on stdout as a single JSON doc (so scripts can read it).
    const doc = JSON.parse(cap.stdout.join('').trim());
    expect(doc.error).toBeTruthy();
    expect(String(doc.error).toLowerCase()).toContain('--yes');
  });

  it('--json --help prints help and does NOT uninstall', async () => {
    // The help check must precede the --json early return: `--json --help` is a
    // help request, not a destructive non-interactive uninstall. Without the
    // ordering fix, the --json branch runs the sweep before help is ever seen.
    const cap = captureOutput();
    let code: number;
    try {
      code = await runUninstall(['--json', '--help']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    // No uninstall side effect: the skills sweep must NOT have run.
    expect(removeAllSkillsMock).not.toHaveBeenCalled();
    const out = cap.stdout.join('') + cap.stderr.join('');
    expect(out).toContain('Usage: wigolo uninstall');
  });

  it('--json --yes emits exactly one JSON plan+result doc on stdout', async () => {
    removeAllSkillsMock.mockReturnValue({
      written: [],
      removed: ['/h/.claude/skills/wigolo/SKILL.md'],
      refused: [],
      notices: [],
    });
    const cap = captureOutput();
    let code: number;
    try {
      code = await runUninstall(['--json', '--yes']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const stdout = cap.stdout.join('').trim();
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    // Exactly one JSON document — human progress must be on stderr.
    expect(lines).toHaveLength(1);
    const doc = JSON.parse(lines[0]) as {
      skills: { removed: number; left: number };
      handlers: unknown[];
      removed: number;
    };
    expect(doc.skills.removed).toBe(1);
    expect(Array.isArray(doc.handlers)).toBe(true);
  });

  it('--json --yes runs the skills sweep BEFORE the no-handlers early return', async () => {
    // The critical ordering: even under --json with no agent handlers detected,
    // the receipt-driven sweep must still execute (it is not gated by handler
    // detection). Assert the sweep ran and the result doc reflects it.
    vi.mocked(detectInstalledHandlers).mockReturnValue([]);
    removeAllSkillsMock.mockReturnValue({
      written: [],
      removed: ['/h/.claude/skills/wigolo/SKILL.md', '/h/.claude/skills/wigolo-search/SKILL.md'],
      refused: [],
      notices: [],
    });
    const cap = captureOutput();
    try {
      await runUninstall(['--json', '--yes']);
    } finally {
      cap.restore();
    }
    expect(removeAllSkillsMock).toHaveBeenCalledTimes(1);
    const doc = JSON.parse(cap.stdout.join('').trim()) as { skills: { removed: number }; handlers: unknown[] };
    expect(doc.skills.removed).toBe(2);
    expect(doc.handlers).toHaveLength(0);
  });
});
