import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getPackageRoot } from '../utils.js';
import type { Pack } from './types.js';

/**
 * The canonical skill-pack catalog. Reads every file in each top-level pack
 * dir under `<packageRoot>/skills/` (not just SKILL.md + rules) so arbitrary
 * pack assets are copied faithfully.
 *
 * getPackageRoot is IMPORTED from ../utils — never re-derived here. This dir is
 * one level deeper than utils.ts; a copied `'../../..'` would silently resolve
 * to dist/cli.
 */

function skillsRoot(): string {
  return join(getPackageRoot(), 'skills');
}

/** Reject path traversal / absolute paths in a pack-relative path. */
export function assertSafeRelPath(rel: string): void {
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) {
    throw new Error(`skills catalog: absolute relPath not allowed: ${rel}`);
  }
  const segments = norm.split('/');
  if (segments.some((s) => s === '..')) {
    throw new Error(`skills catalog: parent traversal not allowed: ${rel}`);
  }
}

/** EOL-normalize before hashing/comparing/writing (writes always LF). */
export function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

interface Frontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(content: string): Frontmatter {
  const norm = normalizeEol(content);
  const m = norm.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Frontmatter = {};
  const body = m[1];
  for (const line of body.split('\n')) {
    if (line.startsWith(' ')) continue;
    const km = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!km) continue;
    if (km[1] === 'name') out.name = km[2].trim();
    if (km[1] === 'description' && km[2].trim() && km[2].trim() !== '|') {
      out.description = km[2].trim();
    }
  }
  // Block-scalar description (`description: |` + indented body).
  const descBlock = body.match(/^description:\s*\|\s*\n((?:[ \t]+.*\n?)+)/m);
  if (descBlock) {
    out.description = descBlock[1]
      .split('\n')
      .map((l) => l.replace(/^\s+/, ''))
      .join(' ')
      .trim();
  }
  return out;
}

function collectFiles(dir: string, baseDir: string, acc: Record<string, string>): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectFiles(full, baseDir, acc);
    } else {
      const rel = relative(baseDir, full).split(sep).join('/');
      assertSafeRelPath(rel);
      acc[rel] = normalizeEol(readFileSync(full, 'utf-8'));
    }
  }
}

/** Load a single pack by name (throws if missing or frontmatter invalid). */
export function loadPack(name: string): Pack {
  const dir = join(skillsRoot(), name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`skills catalog: pack not found: ${name}`);
  }
  const files: Record<string, string> = {};
  collectFiles(dir, dir, files);

  const skillMd = files['SKILL.md'];
  if (!skillMd) {
    throw new Error(`skills catalog: ${name} has no SKILL.md`);
  }
  const fm = parseFrontmatter(skillMd);
  if (fm.name !== name) {
    throw new Error(
      `skills catalog: ${name}/SKILL.md frontmatter name "${fm.name}" != dirname "${name}"`,
    );
  }
  if (!fm.description) {
    throw new Error(`skills catalog: ${name}/SKILL.md missing description`);
  }
  if (fm.description.length > 1024) {
    throw new Error(
      `skills catalog: ${name} description exceeds 1024 chars (${fm.description.length})`,
    );
  }

  return { name, files, description: fm.description };
}

/** List every pack dir name under skills/. */
export function listPackNames(): string[] {
  const root = skillsRoot();
  return readdirSync(root)
    .filter((d) => statSync(join(root, d)).isDirectory())
    .sort();
}

/** Load the full catalog (all packs). */
export function loadCatalog(): Pack[] {
  return listPackNames().map((n) => loadPack(n));
}

let legacyHashesCache: Record<string, Set<string>> | undefined;

/**
 * Legacy content-hash manifest: relPath (pack/relPath) → set of historical
 * sha256s. Used to adopt-and-upgrade files installed by older wigolo versions
 * without a receipt. The `_comment` key is ignored.
 */
export function loadLegacyHashes(): Record<string, Set<string>> {
  if (legacyHashesCache) return legacyHashesCache;
  const p = join(getPackageRoot(), 'assets', 'legacy-skill-hashes.json');
  const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  const out: Record<string, Set<string>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_comment') continue;
    if (Array.isArray(v)) out[k] = new Set(v as string[]);
  }
  legacyHashesCache = out;
  return out;
}

/** Test seam: clear the memoized legacy-hash cache. */
export function resetLegacyHashesCache(): void {
  legacyHashesCache = undefined;
}
