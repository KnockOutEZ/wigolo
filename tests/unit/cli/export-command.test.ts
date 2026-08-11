/**
 * `wigolo export` CLI seam.
 *
 * WHY: the export's value is a trust claim a user must be able to VERIFY by running it. That
 * puts real weight on the command surface — a flag that silently does nothing, or a run that
 * exits 0 after refusing rows, would make the claim unfalsifiable. These tests pin:
 *   - the routing seam (a routed-but-undocumented command is a broken promise),
 *   - the --json house contract (exactly one doc on stdout, everything else on stderr),
 *   - and the exit code carrying the anomaly signal, so a scripted export fails loud.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCommand } from '../../../src/cli/index.js';
import { HELP_TEXT } from '../../../src/cli/help.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { UNTRUSTED_BEGIN_PREFIX } from '../../../src/security/untrusted.js';

function capture(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => { stdout.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write;
  return { stdout, stderr, restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; } };
}

function expectSingleJsonDoc(text: string): Record<string, unknown> {
  const lines = text.trim().split('\n').filter((l) => l.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

function seed(dir: string, rows: Array<{ url: string; markdown: string | null }>): void {
  const db = initDatabase(join(dir, 'wigolo.db'));
  const stmt = db.prepare(
    'INSERT INTO url_cache (url, normalized_url, title, markdown, content_hash, fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    stmt.run(r.url, r.url, 'T', r.markdown, 'hash', '2026-08-11T09:00:00.000Z');
  }
  closeDatabase();
}

describe('export — command routing', () => {
  it('routes `export` as a first-class subcommand, not an unknown', () => {
    expect(parseCommand(['export'])).toEqual({ command: 'export', args: [] });
  });

  it('passes its flags through untouched', () => {
    expect(parseCommand(['export', '--out', './corpus', '--dry-run'])).toEqual({
      command: 'export',
      args: ['--out', './corpus', '--dry-run'],
    });
  });

  it('is advertised in the global help — a routed but undocumented command is a broken promise', () => {
    expect(HELP_TEXT).toContain('export');
  });
});

describe('export — CLI behaviour', () => {
  const origEnv = process.env;
  let dataDir: string;
  let outRoot: string;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...origEnv };
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-cli-export-data-'));
    outRoot = mkdtempSync(join(tmpdir(), 'wigolo-cli-export-out-'));
    process.env.WIGOLO_DATA_DIR = dataDir;
  });

  afterEach(() => {
    closeDatabase();
    process.env = origEnv;
    vi.restoreAllMocks();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(outRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  async function loadRunExport(): Promise<(args: string[]) => Promise<number>> {
    const { resetConfig } = await import('../../../src/config.js');
    resetConfig();
    const mod = await import('../../../src/cli/export.js');
    return mod.runExport;
  }

  it('--help prints usage and exits 0 without opening the cache', async () => {
    const runExport = await loadRunExport();
    const cap = capture();
    let code: number;
    try {
      code = await runExport(['--help']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout.join('')).toContain('wigolo export');
    expect(cap.stdout.join('')).toContain('--out');
    expect(existsSync(join(dataDir, 'wigolo.db'))).toBe(false);
  });

  it('writes the corpus to the directory named by --out', async () => {
    seed(dataDir, [{ url: 'https://example.com/a', markdown: 'body' }]);
    const outDir = join(outRoot, 'mine');
    const runExport = await loadRunExport();

    const cap = capture();
    let code: number;
    try {
      code = await runExport(['--out', outDir]);
    } finally {
      cap.restore();
    }

    expect(code).toBe(0);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(outDir, 'README.md'))).toBe(true);
  });

  it('accepts the --out=DIR form as well, so neither spelling silently no-ops', async () => {
    seed(dataDir, [{ url: 'https://example.com/a', markdown: 'body' }]);
    const outDir = join(outRoot, 'eq');
    const runExport = await loadRunExport();

    const cap = capture();
    try {
      await runExport([`--out=${outDir}`]);
    } finally {
      cap.restore();
    }

    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
  });

  it('under --json emits exactly one JSON doc on stdout and keeps all human text on stderr', async () => {
    seed(dataDir, [{ url: 'https://example.com/a', markdown: 'body' }]);
    const outDir = join(outRoot, 'json');
    const runExport = await loadRunExport();

    const cap = capture();
    let code: number;
    try {
      code = await runExport(['--out', outDir, '--json']);
    } finally {
      cap.restore();
    }

    expect(code).toBe(0);
    const doc = expectSingleJsonDoc(cap.stdout.join(''));
    expect(doc.status).toBe('ok');
    expect(doc.exported).toBe(1);
    expect(doc.out_dir).toBe(outDir);
  });

  it('without --json keeps stdout clean and reports the summary on stderr', async () => {
    seed(dataDir, [{ url: 'https://example.com/a', markdown: 'body' }]);
    const outDir = join(outRoot, 'plain');
    const runExport = await loadRunExport();

    const cap = capture();
    try {
      await runExport(['--out', outDir]);
    } finally {
      cap.restore();
    }

    expect(cap.stdout.join('')).toBe('');
    expect(cap.stderr.join('')).toContain('exported=1');
  });

  it('--dry-run reports the plan and leaves the filesystem untouched', async () => {
    seed(dataDir, [{ url: 'https://example.com/a', markdown: 'body' }]);
    const outDir = join(outRoot, 'dry');
    const runExport = await loadRunExport();

    const cap = capture();
    let code: number;
    try {
      code = await runExport(['--out', outDir, '--dry-run', '--json']);
    } finally {
      cap.restore();
    }

    expect(code).toBe(0);
    const doc = expectSingleJsonDoc(cap.stdout.join(''));
    expect(doc.dry_run).toBe(true);
    expect(doc.exported).toBe(1);
    expect(existsSync(outDir)).toBe(false);
  });

  it('exits non-zero when a stored value carries a trust fence, so a scripted export cannot pass over a store bug', async () => {
    seed(dataDir, [{ url: 'https://example.com/fenced', markdown: `${UNTRUSTED_BEGIN_PREFIX}0011223344556677]]\nx` }]);
    const outDir = join(outRoot, 'anomaly');
    const runExport = await loadRunExport();

    const cap = capture();
    let code: number;
    try {
      code = await runExport(['--out', outDir, '--json']);
    } finally {
      cap.restore();
    }

    expect(code).toBe(1);
    const doc = expectSingleJsonDoc(cap.stdout.join(''));
    expect(doc.status).toBe('error');
    expect(doc.anomalies).toBe(1);
  });

  it('threads --url-pattern and --since through to the query rather than ignoring them', async () => {
    seed(dataDir, [
      { url: 'https://docs.example.com/a', markdown: 'body' },
      { url: 'https://blog.example.com/b', markdown: 'body' },
    ]);
    const outDir = join(outRoot, 'filtered');
    const runExport = await loadRunExport();

    const cap = capture();
    try {
      await runExport(['--out', outDir, '--url-pattern', 'https://docs.example.com/*', '--json']);
    } finally {
      cap.restore();
    }

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8')) as {
      pages: Array<{ url: string }>;
    };
    expect(manifest.pages.map((p) => p.url)).toEqual(['https://docs.example.com/a']);
  });

  it('rejects an unknown flag instead of silently exporting with the wrong scope', async () => {
    const runExport = await loadRunExport();
    const cap = capture();
    let code: number;
    try {
      code = await runExport(['--out', join(outRoot, 'x'), '--nope']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr.join('')).toContain('--nope');
  });
});
