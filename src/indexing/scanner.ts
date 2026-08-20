import { readdirSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { createLogger } from '../logger.js';
import {
  DEFAULT_ALLOWED_EXTENSIONS,
  MAX_INDEX_FILE_BYTES,
  MAX_INDEX_FILES,
  SKIP_BASENAMES,
  SKIP_DIR_NAMES,
  SKIP_EXTENSIONS,
} from './constants.js';
import type { ScanResult, ScannedFile } from './types.js';

const log = createLogger('indexing');

export { MAX_INDEX_FILE_BYTES, MAX_INDEX_FILES } from './constants.js';

/**
 * Match a basename against a simple glob: `*`, `*.ext`, or an exact name.
 * No brace expansion / `**` — recursive walks already cover depth.
 */
export function matchSimpleGlob(name: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p || p === '*') return true;
  if (p.startsWith('*.') && p.length > 2) {
    return name.toLowerCase().endsWith(p.slice(1).toLowerCase());
  }
  return name === p;
}

function isAllowedExtension(name: string, glob: string): boolean {
  if (!matchSimpleGlob(name, glob)) return false;
  const ext = extname(name).toLowerCase();
  if (!ext) return false;
  if (glob === '*') return DEFAULT_ALLOWED_EXTENSIONS.has(ext);
  if (glob.startsWith('*.')) return true;
  return DEFAULT_ALLOWED_EXTENSIONS.has(ext);
}

function shouldSkipDir(name: string): boolean {
  if (SKIP_DIR_NAMES.has(name)) return true;
  return name.startsWith('.');
}

function shouldSkipFile(name: string): string | null {
  if (SKIP_BASENAMES.has(name) || name.startsWith('.env')) {
    return `skipped secret-like file: ${name}`;
  }
  const ext = extname(name).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) {
    return `skipped credential-like extension: ${name}`;
  }
  return null;
}

function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

/**
 * Resolve `source` to a realpath and ensure it stays a local filesystem path
 * (no `http(s):` / `file:` / `internal:` schemes).
 */
export function resolveLocalSource(source: string): { ok: true; root: string } | { ok: false; error: string } {
  const trimmed = source.trim();
  if (!trimmed) {
    return { ok: false, error: 'source must be a non-empty local path' };
  }
  const windowsDrive = /^[a-zA-Z]:[\\/]/.test(trimmed);
  if (!windowsDrive && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return {
      ok: false,
      error: `source must be a local filesystem path (got scheme in "${trimmed}")`,
    };
  }

  try {
    const abs = resolve(trimmed);
    const root = realpathSync(abs);
    const st = statSync(root);
    if (!st.isFile() && !st.isDirectory()) {
      return { ok: false, error: `source is not a file or directory: ${trimmed}` };
    }
    return { ok: true, root };
  } catch (err) {
    return {
      ok: false,
      error: `source not found: ${trimmed} (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * Walk `root` (file or directory), applying glob + safety filters.
 * Symlinks that resolve outside `root` are skipped.
 */
export function scanLocalFiles(
  root: string,
  options: { glob?: string; recursive?: boolean; maxFiles?: number } = {},
): ScanResult {
  const glob = options.glob?.trim() || '*.md';
  const recursive = options.recursive !== false;
  const maxFiles = options.maxFiles ?? MAX_INDEX_FILES;
  const warnings: string[] = [];
  const files: ScannedFile[] = [];
  let capReached = false;

  const rootStat = statSync(root);
  if (rootStat.isFile()) {
    const name = basename(root);
    const skip = shouldSkipFile(name);
    if (skip) {
      warnings.push(skip);
      return { root, files, warnings };
    }
    if (!isAllowedExtension(name, glob)) {
      warnings.push(`file does not match glob ${glob}: ${name}`);
      return { root, files, warnings };
    }
    if (rootStat.size > MAX_INDEX_FILE_BYTES) {
      warnings.push(`file exceeds ${MAX_INDEX_FILE_BYTES} byte cap: ${name}`);
      return { root, files, warnings };
    }
    files.push({ absolutePath: root, relativePath: name });
    return { root, files, warnings };
  }

  const visitedDirs = new Set<string>();

  const visit = (dir: string): void => {
    if (files.length >= maxFiles) return;
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`cannot read directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        capReached = true;
        warnings.push(`file cap reached (${maxFiles}); remaining paths skipped`);
        return;
      }

      const full = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(full);
        } catch {
          warnings.push(`broken symlink skipped: ${full}`);
          continue;
        }
        if (target !== root && !target.startsWith(root + sep)) {
          warnings.push(`symlink escapes scan root, skipped: ${full}`);
          continue;
        }
        let st;
        try {
          st = statSync(target);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (recursive && !shouldSkipDir(entry.name)) visit(target);
          continue;
        }
        if (st.isFile()) {
          const skip = shouldSkipFile(entry.name);
          if (skip) {
            warnings.push(skip);
            continue;
          }
          if (!isAllowedExtension(entry.name, glob)) continue;
          if (st.size > MAX_INDEX_FILE_BYTES) {
            warnings.push(`file exceeds ${MAX_INDEX_FILE_BYTES} byte cap: ${entry.name}`);
            continue;
          }
          files.push({ absolutePath: target, relativePath: toPosixRelative(root, target) });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        if (recursive) visit(full);
        continue;
      }

      if (!entry.isFile()) continue;

      const skip = shouldSkipFile(entry.name);
      if (skip) {
        warnings.push(skip);
        continue;
      }
      if (!isAllowedExtension(entry.name, glob)) continue;

      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.size > MAX_INDEX_FILE_BYTES) {
        warnings.push(`file exceeds ${MAX_INDEX_FILE_BYTES} byte cap: ${entry.name}`);
        continue;
      }

      files.push({
        absolutePath: full,
        relativePath: toPosixRelative(root, full),
      });
    }
  };

  visit(root);
  log.debug('scan complete', { root, count: files.length, warnings: warnings.length, capReached });
  return { root, files, warnings, ...(capReached ? { capReached: true } : {}) };
}
