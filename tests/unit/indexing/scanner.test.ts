import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  matchSimpleGlob,
  resolveLocalSource,
  scanLocalFiles,
  MAX_INDEX_FILES,
} from '../../../src/indexing/scanner.js';

describe('matchSimpleGlob', () => {
  it('matches *.md case-insensitively', () => {
    expect(matchSimpleGlob('README.MD', '*.md')).toBe(true);
    expect(matchSimpleGlob('notes.txt', '*.md')).toBe(false);
  });

  it('matches * and exact names', () => {
    expect(matchSimpleGlob('anything', '*')).toBe(true);
    expect(matchSimpleGlob('exact.md', 'exact.md')).toBe(true);
    expect(matchSimpleGlob('other.md', 'exact.md')).toBe(false);
  });
});

describe('resolveLocalSource', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-scan-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects remote schemes', () => {
    const r = resolveLocalSource('https://example.com/docs');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/scheme/i);
  });

  it('resolves an existing directory', () => {
    const r = resolveLocalSource(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.root).toBeTruthy();
  });

  it('rejects missing paths', () => {
    const r = resolveLocalSource(join(dir, 'nope'));
    expect(r.ok).toBe(false);
  });
});

describe('scanLocalFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-scan-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('recursively finds markdown files', () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'a.md'), '# A');
    writeFileSync(join(dir, 'sub', 'b.md'), '# B');
    writeFileSync(join(dir, 'c.txt'), 'skip');
    const scan = scanLocalFiles(dir, { glob: '*.md', recursive: true });
    expect(scan.files.map((f) => f.relativePath).sort()).toEqual(['a.md', 'sub/b.md']);
  });

  it('skips .env and credential-like files', () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'ok.md'), '# ok');
    writeFileSync(join(dir, 'key.pem'), '-----');
    const scan = scanLocalFiles(dir, { glob: '*', recursive: true });
    expect(scan.files.map((f) => f.relativePath)).toEqual(['ok.md']);
    expect(scan.warnings.some((w) => w.includes('.env') || w.includes('pem'))).toBe(true);
  });

  it('skips symlinks that escape the scan root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'wigolo-out-'));
    try {
      writeFileSync(join(outside, 'secret.md'), '# leak');
      writeFileSync(join(dir, 'local.md'), '# local');
      symlinkSync(join(outside, 'secret.md'), join(dir, 'escape.md'));
      const scan = scanLocalFiles(dir, { glob: '*.md', recursive: true });
      expect(scan.files.map((f) => f.relativePath)).toEqual(['local.md']);
      expect(scan.warnings.some((w) => /escapes/i.test(w))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('respects non-recursive mode', () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'top.md'), '# top');
    writeFileSync(join(dir, 'sub', 'nested.md'), '# nested');
    const scan = scanLocalFiles(dir, { glob: '*.md', recursive: false });
    expect(scan.files.map((f) => f.relativePath)).toEqual(['top.md']);
  });

  it('exports a finite file cap constant', () => {
    expect(MAX_INDEX_FILES).toBeGreaterThan(0);
  });
});
