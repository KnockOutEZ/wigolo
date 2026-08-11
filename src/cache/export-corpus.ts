/**
 * Corpus export — the local cache written out as dated Markdown plus a manifest.
 *
 * The point of this module is a trust claim: everything wigolo caches for you is readable
 * without wigolo, in no proprietary format. That shapes three decisions here.
 *
 *  1. EVERY FILE IS SELF-DESCRIBING. Provenance (url, fetch time, content hash) lives in the
 *     file's own front matter as well as the manifest, so one .md separated from the directory
 *     still says where it came from.
 *  2. NOTHING IS INVENTED. Only columns the store actually holds are emitted; a null column
 *     exports as null rather than a plausible-looking guess.
 *  3. FILENAMES ARE UNTRUSTED INPUT. They are derived from page-controlled urls, so every
 *     segment is sanitised and the resolved path is re-checked against the output root before
 *     a single byte is written.
 *
 * Rows are streamed one at a time (better-sqlite3 `iterate`); a corpus of tens of thousands of
 * pages must never be materialised in memory to be exported.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createLogger } from '../logger.js';
import { initDatabase, closeDatabase } from './db.js';

const log = createLogger('cache');

/** Schema version of manifest.json. Bump on any breaking shape change. */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * The substring common to every trust-fence opener (static and nonce-carrying forms alike).
 *
 * The fence is applied at the response-shaping seam and MUST NOT be persisted; if one is found
 * in a stored value that is a bug in whatever wrote the row. The export refuses that row and
 * names it rather than stripping the marker, because stripping would hide the bug and still
 * hand the reader content of unknown provenance.
 *
 * Kept in sync with src/security/untrusted.ts by an assertion in the test suite, so a rename
 * there cannot silently blind this check.
 */
export const STORED_FENCE_SENTINEL = '[[BEGIN UNTRUSTED DATA';

const MAX_SEGMENT_CHARS = 120;

/** Windows refuses these as filenames outright, with or without an extension. */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export type SkipReason = 'empty_content' | 'fence_marker_in_stored_content';

export interface ExportSkip {
  url: string;
  reason: SkipReason;
}

/**
 * One exported page. Every field is read straight from the store; none is synthesised.
 *
 * `url_cache.extractor_used` is deliberately NOT among them. Its stored values are the names of
 * the libraries in the extraction chain, and the export is user-facing output — surfacing them
 * would leak implementation dependencies into an artifact users read and share. Mapping them to
 * capability language would be inventing a value the store does not hold, which this module does
 * not do, so the field is omitted rather than rewritten. `fetch_method` already carries the part
 * that describes the page's provenance rather than wigolo's internals.
 */
export interface ExportedPage {
  url: string;
  normalized_url: string;
  title: string | null;
  fetched_at: string;
  content_hash: string | null;
  http_status: number | null;
  fetch_method: string | null;
  /** Byte length of the exported markdown body. */
  bytes: number;
  /** True when the capture was labelled a render shell — content is known incomplete. */
  partial: boolean;
  /** Path relative to the output directory, POSIX-or-native per `path.join`. */
  path: string;
}

export interface ExportOptions {
  dataDir: string;
  outDir: string;
  /** GLOB over `normalized_url`, matching `cache clear --url-pattern` semantics. */
  urlPattern?: string;
  /** Only pages fetched after this timestamp (anything SQLite `datetime()` accepts). */
  since?: string;
  dryRun?: boolean;
  onProgress?: (exported: number) => void;
}

export interface ExportResult {
  scanned: number;
  exported: number;
  skipped: ExportSkip[];
  /** Skips that indicate a defect rather than an ordinary gap. Drives a non-zero exit. */
  anomalies: number;
  pages: ExportedPage[];
  outDir: string;
  dryRun: boolean;
}

interface ExportRow {
  url: string;
  normalized_url: string;
  title: string | null;
  markdown: string | null;
  content_hash: string | null;
  fetched_at: string;
  http_status: number | null;
  fetch_method: string | null;
  content_completeness_level?: string | null;
}

/**
 * Reduce an arbitrary, page-controlled string to a single safe path segment.
 *
 * Containment here is structural, not a blocklist: everything outside `[A-Za-z0-9._-]` becomes
 * `-`, which removes separators, NUL bytes, control characters and percent-encodings in one
 * pass. Runs of dots are then collapsed so no `..` can survive, and leading/trailing dots and
 * dashes are trimmed so the segment cannot be a hidden file or an option-looking name.
 */
export function safePathSegment(raw: string, fallback: string): string {
  let s = raw.replace(/[^A-Za-z0-9._-]+/g, '-');
  // Collapse dot runs: `..` (and any longer run) must not survive in any position.
  s = s.replace(/\.{2,}/g, '.');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^[.\-]+/, '').replace(/[.\-]+$/, '');
  s = s.slice(0, MAX_SEGMENT_CHARS).replace(/[.\-]+$/, '');

  if (s.length === 0) return fallback;

  const stem = s.split('.')[0].toUpperCase();
  if (WINDOWS_RESERVED.has(stem)) return `_${s}`.slice(0, MAX_SEGMENT_CHARS);

  return s;
}

/** `YYYY-MM-DD` from a stored timestamp, or the `unknown-date` bucket when it is unparseable. */
function dateBucket(fetchedAt: string | null | undefined): string {
  const head = (fetchedAt ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : 'unknown-date';
}

/** `host` + flattened pathname, e.g. `example.com-docs-intro`. Falls back for unparseable urls. */
function slugForUrl(url: string): string {
  let host = '';
  let path = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    path = parsed.pathname + parsed.search;
  } catch {
    path = url;
  }
  const base = [host, path].filter((p) => p && p !== '/').join('-');
  return safePathSegment(base, 'page');
}

/**
 * YAML scalar for a value the page may control. JSON string syntax is a valid YAML
 * double-quoted scalar, and it escapes newlines and quotes — which is what stops a hostile
 * title from closing the front-matter block and forging its own keys.
 */
function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function renderFrontMatter(page: ExportedPage): string {
  const rows: Array<[string, string | number | boolean | null]> = [
    ['url', page.url],
    ['title', page.title],
    ['fetched_at', page.fetched_at],
    ['content_hash', page.content_hash],
    ['http_status', page.http_status],
    ['fetch_method', page.fetch_method],
    ['partial', page.partial],
  ];
  return ['---', ...rows.map(([k, v]) => `${k}: ${yamlScalar(v)}`), '---', ''].join('\n');
}

function readmeText(exportedAt: string): string {
  return `# Cached page corpus

Exported by wigolo on ${exportedAt}.

This directory is plain files. Nothing here needs wigolo — or any other tool — to read it.
There is no proprietary format: every page is UTF-8 Markdown and the index is JSON.

## Layout

- \`pages/<YYYY-MM-DD>/<name>.md\` — one file per cached page, filed under the date it was
  fetched. Each file opens with a YAML front-matter block carrying that page's source URL,
  fetch timestamp, content hash and HTTP status, followed by the page content as Markdown.
- \`manifest.json\` — the index. One record per exported page with the same provenance fields
  plus its path in this directory, and a \`skipped\` list naming every cached row that was not
  exported and why.

## Reading it

Filenames are derived from the source URL and sanitised, so they are a convenience, not an
identifier — the authoritative URL for any file is the \`url\` field inside it.

\`partial: true\` marks a page the browser engine captured before it had finished rendering.
The content is real but known to be incomplete.

A row listed under \`skipped\` with reason \`empty_content\` was cached without any extracted
text. A reason of \`fence_marker_in_stored_content\` means the stored value carried a
containment marker that should never be written to the cache; those rows are reported rather
than exported, and are worth raising as a bug.
`;
}

const SELECT_BASE = `
  SELECT url, normalized_url, title, markdown, content_hash, fetched_at,
         http_status, fetch_method, content_completeness_level
  FROM url_cache
`;

/**
 * Walk the cache and write it out as Markdown + manifest.
 *
 * `dryRun` computes the complete plan — including the exact relative paths and the skip list —
 * and creates nothing. That makes the flag useful for inspecting the outcome, rather than a
 * partial write with a different shape from the real thing.
 */
export async function exportCorpus(opts: ExportOptions): Promise<ExportResult> {
  const { dataDir, outDir, urlPattern, since, dryRun = false, onProgress } = opts;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (urlPattern) {
    conditions.push('normalized_url GLOB ?');
    params.push(urlPattern);
  }
  if (since) {
    conditions.push('fetched_at > datetime(?)');
    params.push(since);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `${SELECT_BASE} ${where} ORDER BY fetched_at ASC, id ASC`;

  const root = resolve(outDir);
  const rootPrefix = root + sep;
  const pages: ExportedPage[] = [];
  const skipped: ExportSkip[] = [];
  const taken = new Set<string>();
  let scanned = 0;
  let anomalies = 0;

  if (!dryRun) {
    mkdirSync(root, { recursive: true });
  }

  const db = initDatabase(join(dataDir, 'wigolo.db'));
  try {
    // Streamed, not materialised: the corpus can be far larger than memory.
    for (const row of db.prepare(sql).iterate(...params) as Iterable<ExportRow>) {
      scanned += 1;

      const markdown = row.markdown ?? '';
      if (markdown.trim().length === 0) {
        skipped.push({ url: row.url, reason: 'empty_content' });
        continue;
      }

      if (markdown.includes(STORED_FENCE_SENTINEL) || (row.title ?? '').includes(STORED_FENCE_SENTINEL)) {
        // Never strip and never write: a persisted fence is a defect in the writer, and
        // laundering it here would hide that while still emitting content of unknown shape.
        skipped.push({ url: row.url, reason: 'fence_marker_in_stored_content' });
        anomalies += 1;
        log.warn('cached row carries a containment marker — refusing to export', { url: row.url });
        continue;
      }

      const bucket = safePathSegment(dateBucket(row.fetched_at), 'unknown-date');
      let name = slugForUrl(row.url);
      let rel = join('pages', bucket, `${name}.md`);
      for (let n = 2; taken.has(rel); n += 1) {
        name = safePathSegment(`${slugForUrl(row.url)}-${n}`, `page-${n}`);
        rel = join('pages', bucket, `${name}.md`);
      }

      // Belt and braces: sanitising each segment should make this unreachable, so if the
      // resolved path ever leaves the root the row is dropped loudly rather than written.
      const abs = resolve(root, rel);
      if (!abs.startsWith(rootPrefix)) {
        log.error('refusing to write outside the export directory', { url: row.url, rel });
        continue;
      }
      taken.add(rel);

      const body = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
      const page: ExportedPage = {
        url: row.url,
        normalized_url: row.normalized_url,
        title: row.title ?? null,
        fetched_at: row.fetched_at,
        content_hash: row.content_hash ?? null,
        http_status: row.http_status ?? null,
        fetch_method: row.fetch_method ?? null,
        bytes: Buffer.byteLength(body, 'utf-8'),
        partial: row.content_completeness_level === 'shell',
        path: rel,
      };

      if (!dryRun) {
        mkdirSync(join(root, 'pages', bucket), { recursive: true });
        writeFileSync(abs, renderFrontMatter(page) + body, 'utf-8');
      }

      pages.push(page);
      onProgress?.(pages.length);
    }
  } finally {
    closeDatabase();
  }

  const exportedAt = new Date().toISOString();

  if (!dryRun) {
    writeFileSync(
      join(root, 'manifest.json'),
      `${JSON.stringify({
        schema_version: MANIFEST_SCHEMA_VERSION,
        exported_at: exportedAt,
        source: { data_dir: dataDir },
        filters: {
          url_pattern: urlPattern ?? null,
          since: since ?? null,
        },
        counts: {
          scanned,
          exported: pages.length,
          skipped: skipped.length,
          anomalies,
        },
        pages,
        skipped,
      }, null, 2)}\n`,
      'utf-8',
    );
    writeFileSync(join(root, 'README.md'), readmeText(exportedAt), 'utf-8');
  }

  return { scanned, exported: pages.length, skipped, anomalies, pages, outDir, dryRun };
}
