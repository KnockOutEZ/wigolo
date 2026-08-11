/**
 * `wigolo export` — corpus to dated Markdown + a manifest.
 *
 * WHY this exists: the export is a TRUST ARTIFACT. Its whole claim is "your corpus is
 * readable without wigolo, in no proprietary format". Every assertion below defends one
 * leg of that claim:
 *
 *  - Self-describing files. A page must carry its own provenance (url, fetch time, hash)
 *    so a single .md separated from the directory still tells you where it came from.
 *  - An honest manifest. It reports what the cache actually holds — including the rows it
 *    could NOT export — because a silent omission is exactly the kind of thing "no
 *    proprietary format" is supposed to rule out.
 *  - Containment. Exported filenames are derived from PAGE-CONTROLLED urls. A hostile URL
 *    that escapes the output directory turns a read-only trust feature into an arbitrary
 *    file write. That is the sharpest failure mode here, so it is probed directly.
 *  - No persisted fence. Trust markers are applied at the response-shaping seam, never in
 *    the store. If one is on disk that is a bug in the WRITER; the export must refuse and
 *    report it rather than launder it into the user's filesystem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import {
  exportCorpus,
  safePathSegment,
  STORED_FENCE_SENTINEL,
  type ExportResult,
} from '../../../src/cache/export-corpus.js';
import { UNTRUSTED_BEGIN_PREFIX } from '../../../src/security/untrusted.js';

interface SeedRow {
  url: string;
  title?: string | null;
  markdown?: string | null;
  contentHash?: string | null;
  fetchedAt?: string;
  httpStatus?: number | null;
  fetchMethod?: string | null;
  extractorUsed?: string | null;
  completenessLevel?: string | null;
}

function seed(dir: string, rows: SeedRow[]): void {
  const db = initDatabase(join(dir, 'wigolo.db'));
  const stmt = db.prepare(`
    INSERT INTO url_cache
      (url, normalized_url, title, markdown, raw_html, metadata, links, images,
       fetch_method, extractor_used, content_hash, fetched_at, http_status,
       content_completeness_level)
    VALUES (?, ?, ?, ?, '', '{}', '[]', '[]', ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(
      r.url,
      r.url,
      r.title ?? null,
      r.markdown ?? null,
      r.fetchMethod ?? 'http',
      r.extractorUsed ?? 'defuddle',
      'contentHash' in r ? r.contentHash ?? null : 'seedhash',
      r.fetchedAt ?? '2026-08-11T09:00:00.000Z',
      'httpStatus' in r ? r.httpStatus ?? null : 200,
      r.completenessLevel ?? null,
    );
  }
  closeDatabase();
}

function readManifest(outDir: string): {
  schema_version: number;
  exported_at: string;
  source: { data_dir: string };
  counts: { scanned: number; exported: number; skipped: number; anomalies: number };
  pages: Array<Record<string, unknown>>;
  skipped: Array<{ url: string; reason: string }>;
} {
  return JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
}

/** Every regular file under `root`, as paths relative to `root`. */
function walk(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

describe('exportCorpus — layout and self-description', () => {
  let dataDir: string;
  let outDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-export-data-'));
    outDir = join(mkdtempSync(join(tmpdir(), 'wigolo-export-out-')), 'corpus');
  });

  afterEach(() => {
    closeDatabase();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('files a page under pages/<fetch-date>/ so the corpus is browsable by when it was captured', async () => {
    seed(dataDir, [
      { url: 'https://example.com/docs/intro', title: 'Intro', markdown: '# Intro\n\nbody', fetchedAt: '2026-08-11T09:00:00.000Z' },
      { url: 'https://example.com/docs/old', title: 'Old', markdown: '# Old\n\nbody', fetchedAt: '2026-01-02T09:00:00.000Z' },
    ]);

    const result = await exportCorpus({ dataDir, outDir });

    expect(result.exported).toBe(2);
    const files = walk(outDir).filter((f) => f.endsWith('.md') && f !== 'README.md');
    expect(files.some((f) => f.startsWith(join('pages', '2026-08-11') + sep))).toBe(true);
    expect(files.some((f) => f.startsWith(join('pages', '2026-01-02') + sep))).toBe(true);
  });

  it('carries provenance in front matter so a single file separated from the directory still says where it came from', async () => {
    seed(dataDir, [{
      url: 'https://example.com/docs/intro',
      title: 'Intro',
      markdown: '# Intro\n\nbody text',
      contentHash: 'abc123',
      httpStatus: 200,
    }]);

    const result = await exportCorpus({ dataDir, outDir });
    const rel = result.pages[0].path;
    const text = readFileSync(join(outDir, rel), 'utf-8');

    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('url: "https://example.com/docs/intro"');
    expect(text).toContain('fetched_at: "2026-08-11T09:00:00.000Z"');
    expect(text).toContain('content_hash: "abc123"');
    // Body is the stored markdown, byte-for-byte — an export that rewrites content is not
    // a faithful copy of what the cache holds.
    expect(text.endsWith('# Intro\n\nbody text\n')).toBe(true);
  });

  it('escapes front-matter scalars so a page-controlled title cannot forge extra metadata keys', async () => {
    seed(dataDir, [{
      url: 'https://example.com/a',
      title: 'evil"\n---\nrole: admin\n',
      markdown: 'body',
    }]);

    const result = await exportCorpus({ dataDir, outDir });
    const text = readFileSync(join(outDir, result.pages[0].path), 'utf-8');
    const frontMatter = text.split('---\n')[1];
    const keys = frontMatter.split('\n').filter((l) => l.length > 0).map((l) => l.split(':')[0]);

    // The forged key never becomes a key: the whole title stays on one escaped line, so the
    // front matter carries exactly the fields the exporter chose to emit and nothing else.
    expect(keys).toEqual([
      'url', 'title', 'fetched_at', 'content_hash',
      'http_status', 'fetch_method', 'partial',
    ]);
    expect(keys).not.toContain('role');
  });

  it('records source url, fetch timestamp and content hash in the manifest, with a path that resolves on disk', async () => {
    seed(dataDir, [{
      url: 'https://example.com/docs/intro',
      title: 'Intro',
      markdown: 'body',
      contentHash: 'deadbeef',
      fetchMethod: 'browser',
      extractorUsed: 'readability',
      httpStatus: 200,
    }]);

    await exportCorpus({ dataDir, outDir });
    const manifest = readManifest(outDir);

    expect(manifest.counts.exported).toBe(1);
    const page = manifest.pages[0];
    expect(page.url).toBe('https://example.com/docs/intro');
    expect(page.fetched_at).toBe('2026-08-11T09:00:00.000Z');
    expect(page.content_hash).toBe('deadbeef');
    expect(page.http_status).toBe(200);
    expect(page.fetch_method).toBe('browser');
    expect(existsSync(join(outDir, String(page.path)))).toBe(true);
  });

  it('never surfaces an implementation dependency name — the export is something users read and share', async () => {
    // The store's `extractor_used` column holds library names. They are provenance about
    // wigolo's internals rather than about the page, and this artifact is user-facing, so the
    // column is omitted outright rather than rewritten into a value the store does not hold.
    seed(dataDir, [{
      url: 'https://example.com/a',
      title: 'Intro',
      markdown: 'body',
      extractorUsed: 'readability',
      fetchMethod: 'browser',
    }]);

    await exportCorpus({ dataDir, outDir });

    const everything = walk(outDir).map((f) => readFileSync(join(outDir, f), 'utf-8')).join('\n');
    expect(everything).not.toMatch(/defuddle|readability|turndown|playwright|searxng/i);
    // The capability-language field that DOES describe the page survives, so this is a
    // narrowing of what is exported, not a blanket loss of provenance.
    expect(everything).toContain('"browser"');
  });

  it('writes a README that names the layout, so the directory explains itself with no wigolo installed', async () => {
    seed(dataDir, [{ url: 'https://example.com/a', markdown: 'body' }]);

    await exportCorpus({ dataDir, outDir });
    const readme = readFileSync(join(outDir, 'README.md'), 'utf-8');

    expect(readme).toContain('manifest.json');
    expect(readme).toContain('pages/');
    // The trust claim is the point of the artifact; it must be stated in the artifact.
    expect(readme.toLowerCase()).toContain('no proprietary format');
  });

  it('never invents metadata the store does not hold — a null column exports as null, not a guess', async () => {
    seed(dataDir, [{
      url: 'https://example.com/a',
      markdown: 'body',
      contentHash: null,
      httpStatus: null,
      title: null,
    }]);

    await exportCorpus({ dataDir, outDir });
    const page = readManifest(outDir).pages[0];

    expect(page.content_hash).toBeNull();
    expect(page.http_status).toBeNull();
    expect(page.title).toBeNull();
  });
});

describe('exportCorpus — rows the cache cannot honestly export', () => {
  let dataDir: string;
  let outDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-export-data-'));
    outDir = join(mkdtempSync(join(tmpdir(), 'wigolo-export-out-')), 'corpus');
  });

  afterEach(() => {
    closeDatabase();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('does not emit an empty file for a contentless row — it reports the row as skipped instead', async () => {
    seed(dataDir, [
      { url: 'https://example.com/empty', markdown: null },
      { url: 'https://example.com/blank', markdown: '   \n  ' },
      { url: 'https://example.com/real', markdown: 'body' },
    ]);

    const result = await exportCorpus({ dataDir, outDir });

    expect(result.exported).toBe(1);
    expect(result.skipped.map((s) => s.reason)).toEqual(['empty_content', 'empty_content']);
    const mdFiles = walk(outDir).filter((f) => f.startsWith('pages'));
    expect(mdFiles).toHaveLength(1);
    // The manifest is the honest record: the rows exist in the cache and the reader is told so.
    expect(readManifest(outDir).skipped.map((s) => s.url).sort()).toEqual([
      'https://example.com/blank',
      'https://example.com/empty',
    ]);
  });

  it('exports a partial capture but labels it, so a reader is never told a shell page is complete', async () => {
    seed(dataDir, [{
      url: 'https://example.com/spa',
      markdown: 'loading…',
      completenessLevel: 'shell',
    }]);

    const result = await exportCorpus({ dataDir, outDir });

    expect(result.exported).toBe(1);
    expect(result.pages[0].partial).toBe(true);
    expect(readFileSync(join(outDir, result.pages[0].path), 'utf-8')).toContain('partial: true');
    expect(readManifest(outDir).pages[0].partial).toBe(true);
  });

  it('labels a complete capture as not partial', async () => {
    seed(dataDir, [{ url: 'https://example.com/ok', markdown: 'body', completenessLevel: 'complete' }]);

    const result = await exportCorpus({ dataDir, outDir });

    expect(result.pages[0].partial).toBe(false);
  });
});

describe('exportCorpus — a persisted fence is a bug, not something to strip', () => {
  let dataDir: string;
  let outDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-export-data-'));
    outDir = join(mkdtempSync(join(tmpdir(), 'wigolo-export-out-')), 'corpus');
  });

  afterEach(() => {
    closeDatabase();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('tracks the security module\'s marker prefix, so a rename there cannot silently blind this check', () => {
    // Outside signal: the sentinel is not a private copy of a string that may drift — it is
    // asserted against the constant the fence itself is built from.
    expect(UNTRUSTED_BEGIN_PREFIX.startsWith(STORED_FENCE_SENTINEL)).toBe(true);
  });

  it('refuses a row whose stored markdown carries a fence marker, and names it as an anomaly', async () => {
    seed(dataDir, [
      { url: 'https://example.com/fenced', markdown: `${UNTRUSTED_BEGIN_PREFIX}0011223344556677]]\nbody` },
      { url: 'https://example.com/clean', markdown: 'body' },
    ]);

    const result = await exportCorpus({ dataDir, outDir });

    expect(result.exported).toBe(1);
    expect(result.anomalies).toBe(1);
    expect(result.skipped).toContainEqual({
      url: 'https://example.com/fenced',
      reason: 'fence_marker_in_stored_content',
    });
    // Never laundered onto the filesystem, in any form.
    for (const f of walk(outDir)) {
      expect(readFileSync(join(outDir, f), 'utf-8')).not.toContain(STORED_FENCE_SENTINEL);
    }
  });

  it('counts an empty row as skipped but NOT as an anomaly — the two must not be conflated', async () => {
    seed(dataDir, [{ url: 'https://example.com/empty', markdown: null }]);

    const result = await exportCorpus({ dataDir, outDir });

    expect(result.skipped).toHaveLength(1);
    expect(result.anomalies).toBe(0);
  });
});

describe('safePathSegment — filenames are derived from attacker-controlled urls', () => {
  it('strips separators so a path segment can never introduce a new directory level', () => {
    expect(safePathSegment('a/b/c', 'fallback')).not.toContain('/');
    expect(safePathSegment('a\\b\\c', 'fallback')).not.toContain('\\');
  });

  it('cannot produce a parent-directory reference', () => {
    for (const hostile of ['..', '../..', '....//....//etc', '%2e%2e%2f', '..%2f..%2f']) {
      const seg = safePathSegment(hostile, 'fallback');
      expect(seg).not.toContain('..');
      expect(seg).not.toBe('.');
    }
  });

  it('rejects a NUL byte rather than letting it truncate the path at the syscall boundary', () => {
    // The NUL is written as the \0 ESCAPE, never as a raw 0x00 byte. A raw NUL makes grep treat
    // this whole file as binary and report nothing from that offset on — it would silence review
    // of every assertion below it, in the one file where that matters most.
    const hostile = 'safe\0/..' + '/../etc/passwd';
    const seg = safePathSegment(hostile, 'fallback');

    expect(seg).not.toContain('\0');
    // The bytes on BOTH sides of the NUL must be neutralised. A path layer that truncates at
    // the NUL sees 'safe'; one that does not sees the traversal. Neither may reach a filename.
    expect(seg).not.toContain('..');
    expect(seg).not.toContain('/');
  });

  it('falls back rather than returning an empty or dot-only name', () => {
    expect(safePathSegment('', 'fallback')).toBe('fallback');
    expect(safePathSegment('...', 'fallback')).toBe('fallback');
    expect(safePathSegment('///', 'fallback')).toBe('fallback');
  });

  it('escapes Windows reserved device names, which cannot be opened as files at all', () => {
    for (const reserved of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
      expect(safePathSegment(reserved, 'fallback').toUpperCase()).not.toBe(reserved.toUpperCase());
    }
  });

  it('bounds the length so a long url cannot blow the filesystem name limit', () => {
    expect(safePathSegment('a'.repeat(4000), 'fallback').length).toBeLessThanOrEqual(120);
  });
});

describe('exportCorpus — path-traversal containment (falsifiability probe)', () => {
  let dataDir: string;
  let sandbox: string;
  let outDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-export-data-'));
    sandbox = mkdtempSync(join(tmpdir(), 'wigolo-export-sandbox-'));
    outDir = join(sandbox, 'corpus');
    mkdirSync(join(sandbox, 'outside'), { recursive: true });
  });

  afterEach(() => {
    closeDatabase();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* */ }
  });

  /**
   * Which vectors matter, and why the obvious ones do not.
   *
   * For an http(s) url the WHATWG parser already collapses parent-directory segments — the
   * literal form AND the percent-encoded one — out of `pathname` before this code sees it.
   * Measured, not assumed. A probe built only from those would be self-satisfying: it would
   * stay green with the sanitiser deleted. So the list leads with the two shapes the parser
   * does NOT normalise, which carry the real risk:
   *   - an OPAQUE scheme (`data:`, a `studio:` artifact URI, `mailto:`), whose `pathname` is
   *     handed back verbatim;
   *   - a value that does not parse as a url at all, where the raw string is the only path
   *     material available.
   * The http rows are kept as controls: they document what the parser already handles, so a
   * later reader does not over-credit them.
   */
  it('writes every file inside the output directory even when urls, titles and timestamps are hostile', async () => {
    seed(dataDir, [
      // NOT normalised by the url parser — these are the shapes that actually escape.
      { url: 'data:../../../../outside/esc0', markdown: 'x' },
      { url: 'studio:../../../../outside/esc1', markdown: 'x' },
      { url: '../../../../outside/esc2', markdown: 'x' },
      { url: '/../../../outside/esc3', markdown: 'x' },
      // Controls: the url parser collapses these before the exporter ever sees them.
      { url: 'https://example.com/../../../../outside/esc4', markdown: 'x' },
      { url: 'https://example.com/%2e%2e%2f%2e%2e%2foutside%2fesc5', markdown: 'x' },
      { url: 'https://../../outside/esc6', markdown: 'x' },
      // Neither a page-controlled title nor a stored timestamp may reach a path at all.
      { url: 'https://example.com/a', title: '../../outside/esc7', markdown: 'x' },
      { url: 'https://example.com/b', markdown: 'x', fetchedAt: '../../outside' },
    ]);

    const root = resolve(outDir) + sep;

    // The PLAN first, via dry-run. Checking the plan is what makes this probe decisive:
    // it reaches the containment assertion without any filesystem write in the way, so a
    // regression shows up as "this path escapes" rather than as an incidental write error
    // on some unrelated row processed earlier.
    const planned = await exportCorpus({ dataDir, outDir, dryRun: true });
    expect(planned.pages.length).toBeGreaterThan(0);
    for (const page of planned.pages) {
      expect(resolve(outDir, page.path).startsWith(root), `planned path escapes: ${page.url}`).toBe(true);
    }

    // Then the real write, and the observable consequence — independent of what the result
    // object claims, nothing landed in the sibling directory.
    const result = await exportCorpus({ dataDir, outDir });
    for (const page of result.pages) {
      expect(resolve(outDir, page.path).startsWith(root), `written path escapes: ${page.url}`).toBe(true);
    }
    expect(readdirSync(join(sandbox, 'outside'))).toEqual([]);
    expect(readdirSync(sandbox).sort()).toEqual(['corpus', 'outside']);
  });

  it('buckets an unparseable fetch timestamp instead of letting it name a directory', async () => {
    seed(dataDir, [{ url: 'https://example.com/a', markdown: 'x', fetchedAt: '../../outside' }]);

    const result = await exportCorpus({ dataDir, outDir });

    expect(result.pages[0].path.startsWith(join('pages', 'unknown-date'))).toBe(true);
  });

  it('de-collides urls that are already at the name-length cap, instead of spinning forever', async () => {
    // Both slugs truncate to the same 120 characters, so every candidate name collides. If the
    // de-collision suffix were appended to a name already at the cap it would be truncated
    // straight back off, the candidate would never change, and the export would hang — a
    // corpus-wide denial of service triggered by two long urls sharing a prefix.
    const long = 'x'.repeat(300);
    seed(dataDir, [
      { url: `https://example.com/${long}a`, markdown: 'first' },
      { url: `https://example.com/${long}b`, markdown: 'second' },
      { url: `https://example.com/${long}c`, markdown: 'third' },
    ]);

    const result = await exportCorpus({ dataDir, outDir });

    expect(result.exported).toBe(3);
    expect(new Set(result.pages.map((p) => p.path)).size).toBe(3);
    const bodies = result.pages.map((p) => readFileSync(join(outDir, p.path), 'utf-8'));
    expect(bodies.filter((b) => b.includes('first'))).toHaveLength(1);
    expect(bodies.filter((b) => b.includes('third'))).toHaveLength(1);
  });

  it('gives colliding urls distinct files so no page silently overwrites another', async () => {
    seed(dataDir, [
      { url: 'https://example.com/a/b', markdown: 'first' },
      { url: 'https://example.com/a-b', markdown: 'second' },
      { url: 'https://example.com/a_b', markdown: 'third' },
    ]);

    const result = await exportCorpus({ dataDir, outDir });

    expect(result.exported).toBe(3);
    const paths = result.pages.map((p) => p.path);
    expect(new Set(paths).size).toBe(3);
    const bodies = paths.map((p) => readFileSync(join(outDir, p), 'utf-8'));
    expect(bodies.filter((b) => b.includes('first'))).toHaveLength(1);
    expect(bodies.filter((b) => b.includes('second'))).toHaveLength(1);
    expect(bodies.filter((b) => b.includes('third'))).toHaveLength(1);
  });
});

describe('exportCorpus — filters, dry-run and incremental processing', () => {
  let dataDir: string;
  let outDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-export-data-'));
    outDir = join(mkdtempSync(join(tmpdir(), 'wigolo-export-out-')), 'corpus');
  });

  afterEach(() => {
    closeDatabase();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('restricts the export to urls matching the pattern', async () => {
    seed(dataDir, [
      { url: 'https://docs.example.com/a', markdown: 'x' },
      { url: 'https://blog.example.com/b', markdown: 'x' },
    ]);

    const result = await exportCorpus({ dataDir, outDir, urlPattern: 'https://docs.example.com/*' });

    expect(result.pages.map((p) => p.url)).toEqual(['https://docs.example.com/a']);
  });

  it('restricts the export by fetch time', async () => {
    seed(dataDir, [
      { url: 'https://example.com/new', markdown: 'x', fetchedAt: '2026-08-10T00:00:00.000Z' },
      { url: 'https://example.com/old', markdown: 'x', fetchedAt: '2020-01-01T00:00:00.000Z' },
    ]);

    const result = await exportCorpus({ dataDir, outDir, since: '2026-01-01' });

    expect(result.pages.map((p) => p.url)).toEqual(['https://example.com/new']);
  });

  it('dry-run reports the full plan and creates nothing on disk — the flag is for inspecting, not for a partial write', async () => {
    seed(dataDir, [
      { url: 'https://example.com/a', markdown: 'x' },
      { url: 'https://example.com/empty', markdown: null },
    ]);

    const result = await exportCorpus({ dataDir, outDir, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.exported).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.pages[0].path).toBeTruthy();
    expect(existsSync(outDir)).toBe(false);
  });

  it('reports progress per page as it goes, so a large corpus is processed row by row rather than materialised', async () => {
    seed(dataDir, Array.from({ length: 25 }, (_, i) => ({
      url: `https://example.com/p${i}`,
      markdown: `body ${i}`,
    })));

    const seenAt: number[] = [];
    const result: ExportResult = await exportCorpus({
      dataDir,
      outDir,
      onProgress: (done) => seenAt.push(done),
    });

    expect(result.exported).toBe(25);
    expect(seenAt).toHaveLength(25);
    expect(seenAt[0]).toBe(1);
    expect(seenAt[seenAt.length - 1]).toBe(25);
  });

  it('reports an empty cache honestly rather than failing', async () => {
    seed(dataDir, []);

    const result = await exportCorpus({ dataDir, outDir });

    expect(result.scanned).toBe(0);
    expect(result.exported).toBe(0);
    // The manifest and README still exist: an empty corpus is a valid, readable answer.
    expect(readManifest(outDir).counts.exported).toBe(0);
    expect(existsSync(join(outDir, 'README.md'))).toBe(true);
  });
});
