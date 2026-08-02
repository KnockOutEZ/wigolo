import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPackageRoot } from '../../../../../src/cli/agents/utils.js';
import {
  loadPack,
  listPackNames,
  loadCatalog,
  loadLegacyHashes,
  assertSafeRelPath,
  normalizeEol,
} from '../../../../../src/cli/agents/skills/catalog.js';

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

describe('catalog — dev layout pinning', () => {
  it('getPackageRoot resolves a skills/ dir that exists (guards a copied ../../..)', () => {
    expect(existsSync(join(getPackageRoot(), 'skills'))).toBe(true);
    expect(existsSync(join(getPackageRoot(), 'assets', 'legacy-skill-hashes.json'))).toBe(true);
  });
});

describe('listPackNames', () => {
  it('lists exactly the 11 canonical packs', () => {
    expect(listPackNames().sort()).toEqual([...EXPECTED_PACKS].sort());
  });
});

describe('loadPack', () => {
  it('loads SKILL.md + nested rules files by relative path', () => {
    const pack = loadPack('wigolo');
    expect(pack.name).toBe('wigolo');
    expect(pack.files['SKILL.md']).toBeTruthy();
    // Hub pack ships rules/ subdir files — copier must recurse.
    expect(pack.files['rules/cache-first.md']).toBeTruthy();
    expect(pack.files['rules/synthesis.md']).toBeTruthy();
    expect(pack.description.length).toBeGreaterThan(0);
    expect(pack.description.length).toBeLessThanOrEqual(1024);
  });

  it('name in frontmatter matches dirname for every pack', () => {
    for (const name of EXPECTED_PACKS) {
      expect(loadPack(name).name).toBe(name);
    }
  });

  it('all pack content is EOL-normalized (no CRLF)', () => {
    for (const pack of loadCatalog()) {
      for (const [rel, content] of Object.entries(pack.files)) {
        expect(content.includes('\r\n'), `${pack.name}/${rel}`).toBe(false);
      }
    }
  });

  it('throws for an unknown pack', () => {
    expect(() => loadPack('does-not-exist')).toThrow(/pack not found/);
  });
});

describe('loadCatalog', () => {
  it('returns all 11 packs', () => {
    expect(loadCatalog()).toHaveLength(11);
  });
});

describe('loadLegacyHashes', () => {
  it('parses the manifest into relPath → Set<sha256>, ignoring _comment', () => {
    const hashes = loadLegacyHashes();
    expect(hashes['_comment']).toBeUndefined();
    expect(hashes['wigolo-search/SKILL.md']).toBeInstanceOf(Set);
    expect(hashes['wigolo-search/SKILL.md'].size).toBeGreaterThanOrEqual(1);
  });
});

describe('assertSafeRelPath — negative', () => {
  it('rejects parent traversal', () => {
    expect(() => assertSafeRelPath('../evil.md')).toThrow(/parent traversal/);
    expect(() => assertSafeRelPath('rules/../../evil.md')).toThrow(/parent traversal/);
  });

  it('rejects absolute paths (posix + windows)', () => {
    expect(() => assertSafeRelPath('/etc/passwd')).toThrow(/absolute/);
    expect(() => assertSafeRelPath('C:\\Windows\\x')).toThrow(/absolute/);
  });

  it('accepts a plain nested path', () => {
    expect(() => assertSafeRelPath('rules/cache-first.md')).not.toThrow();
  });
});

describe('normalizeEol', () => {
  it('converts CRLF to LF', () => {
    expect(normalizeEol('a\r\nb\r\n')).toBe('a\nb\n');
  });
});
