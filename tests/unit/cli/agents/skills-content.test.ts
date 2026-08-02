import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const BLOCKS_DIR = join(REPO_ROOT, 'assets', 'blocks');
const LEGACY_HASHES = join(REPO_ROOT, 'assets', 'legacy-skill-hashes.json');

// The 11 canonical packs — one per MCP tool plus the umbrella hub.
const EXPECTED_PACKS = [
  'wigolo',
  'wigolo-search',
  'wigolo-fetch',
  'wigolo-crawl',
  'wigolo-cache',
  'wigolo-extract',
  'wigolo-find-similar',
  'wigolo-research',
  'wigolo-agent',
  'wigolo-diff',
  'wigolo-watch',
];

// The 10 tool packs the hub must link to (everything except the hub itself).
const TOOL_PACKS = EXPECTED_PACKS.filter((p) => p !== 'wigolo');

function parseFrontmatter(content: string): { name?: string; description?: string; license?: string } {
  const norm = content.replace(/\r\n/g, '\n');
  const m = norm.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    // Top-level scalar keys only; `description: |` block-scalars are handled below.
    const km = line.match(/^([a-z_]+):\s*(.*)$/);
    if (km && !line.startsWith(' ')) {
      out[km[1]] = km[2].trim();
    }
  }
  // Block-scalar description (`description: |` followed by an indented body).
  const descBlock = m[1].match(/^description:\s*\|\s*\n((?:[ \t]+.*\n?)+)/m);
  if (descBlock) {
    out.description = descBlock[1]
      .split('\n')
      .map((l) => l.replace(/^\s+/, ''))
      .join(' ')
      .trim();
  }
  return out;
}

function walkMd(dir: string, base: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkMd(full, base, acc);
    else if (name.endsWith('.md') || name.endsWith('.block') || name.endsWith('.mdc'))
      acc.push(full);
  }
}

describe('skills content gates', () => {
  describe('windsurf digest budgets', () => {
    it('rules-project.md is <= 11000 chars', () => {
      const p = join(BLOCKS_DIR, 'windsurf', 'rules-project.md');
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, 'utf-8').length).toBeLessThanOrEqual(11000);
    });

    it('rules-global.md is <= 2500 chars', () => {
      const p = join(BLOCKS_DIR, 'windsurf', 'rules-global.md');
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, 'utf-8').length).toBeLessThanOrEqual(2500);
    });

    it('both digests cover all 10 tools', () => {
      for (const file of ['rules-project.md', 'rules-global.md']) {
        const content = readFileSync(join(BLOCKS_DIR, 'windsurf', file), 'utf-8');
        for (const tool of ['search', 'fetch', 'crawl', 'cache', 'extract', 'find_similar', 'research', 'agent', 'diff', 'watch']) {
          expect(content, `${file} missing ${tool}`).toContain(tool);
        }
      }
    });
  });

  describe('every pack SKILL.md frontmatter', () => {
    for (const pack of EXPECTED_PACKS) {
      it(`${pack} has name==dirname, description<=1024, license AGPL-3.0-only`, () => {
        const p = join(SKILLS_DIR, pack, 'SKILL.md');
        expect(existsSync(p), `missing ${p}`).toBe(true);
        const fm = parseFrontmatter(readFileSync(p, 'utf-8'));
        expect(fm.name).toBe(pack);
        expect(fm.description).toBeTruthy();
        expect((fm.description as string).length).toBeLessThanOrEqual(1024);
        expect(fm.license).toBe('AGPL-3.0-only');
      });
    }

    it('there are exactly the 10 canonical packs and no extras', () => {
      const dirs = readdirSync(SKILLS_DIR).filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory());
      expect(dirs.sort()).toEqual([...EXPECTED_PACKS].sort());
    });
  });

  describe('hub pack links every tool pack (catalog == hub-links)', () => {
    it('wigolo/SKILL.md links all 10 tool packs by relative path', () => {
      const hub = readFileSync(join(SKILLS_DIR, 'wigolo', 'SKILL.md'), 'utf-8');
      for (const pack of TOOL_PACKS) {
        expect(hub, `hub missing link to ${pack}`).toContain(`../${pack}/SKILL.md`);
      }
    });
  });

  describe('capability language — no implementation-dep leaks', () => {
    // Library/impl names that must never appear in user-facing skill/block text.
    // The literal WIGOLO_SEARCH config value `searxng`/`hybrid` is sanctioned
    // (mirrors src/instructions.ts) and is not in this list.
    const FORBIDDEN = /Playwright|SearXNG|Trafilatura|Defuddle|Readability|Turndown|FlashRank|fastembed|ONNX|BGE|sqlite-vec|FTS5|Chromium/;

    it('no forbidden implementation names in skills/** or assets/blocks/**', () => {
      const files: string[] = [];
      walkMd(SKILLS_DIR, SKILLS_DIR, files);
      walkMd(BLOCKS_DIR, BLOCKS_DIR, files);
      const offenders: string[] = [];
      for (const file of files) {
        for (const line of readFileSync(file, 'utf-8').split('\n')) {
          // Allowlist: the WIGOLO_SEARCH config value context is sanctioned.
          if (/WIGOLO_SEARCH=(searxng|hybrid)/.test(line)) continue;
          if (FORBIDDEN.test(line)) {
            offenders.push(`${file.replace(REPO_ROOT + '/', '')}: ${line.trim()}`);
          }
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  });

  describe('legacy skill-hash manifest', () => {
    it('parses and documents its generation command', () => {
      const raw = JSON.parse(readFileSync(LEGACY_HASHES, 'utf-8')) as Record<string, unknown>;
      expect(typeof raw._comment).toBe('string');
      expect(raw._comment as string).toContain('gen-legacy-skill-hashes');
    });

    it('every current skill-pack file has a manifest entry', () => {
      const raw = JSON.parse(readFileSync(LEGACY_HASHES, 'utf-8')) as Record<string, string[]>;
      const files: string[] = [];
      walkMdFiles(SKILLS_DIR, SKILLS_DIR, files);
      for (const rel of files) {
        expect(raw[rel], `manifest missing ${rel}`).toBeTruthy();
        expect(Array.isArray(raw[rel])).toBe(true);
      }
    });

    it('carries >=2 distinct hashes for a file that changed since v0.2.0', () => {
      const raw = JSON.parse(readFileSync(LEGACY_HASHES, 'utf-8')) as Record<string, string[]>;
      // wigolo-search/SKILL.md differs between v0.2.0 and 97986b0c and was
      // rewritten again in this slice — its historical union must be >= 2.
      const anyMulti = Object.entries(raw)
        .filter(([k]) => k !== '_comment')
        .some(([, hashes]) => Array.isArray(hashes) && new Set(hashes).size >= 2);
      expect(anyMulti).toBe(true);
    });
  });
});

// Only *.md pack files (not blocks) for the manifest-coverage check.
// Keys must match the manifest's forward-slash repo-relative shape (the runtime
// catalog normalizes with `relative(base, full).split(sep).join('/')`), so
// backslash separators on Windows do not break the lookup.
function walkMdFiles(dir: string, base: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkMdFiles(full, base, acc);
    else if (name.endsWith('.md')) acc.push(relative(base, full).split(sep).join('/'));
  }
}
