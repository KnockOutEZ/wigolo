import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyProfileToTemp, removeTempProfile, TEMP_PROFILE_PREFIX } from '../../../src/fetch/profile-copy.js';

describe('profile-copy', () => {
  let sourceDir: string;
  const madeCopies: string[] = [];

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), 'wigolo-profile-src-'));
    writeFileSync(join(sourceDir, 'Cookies'), 'cookie-bytes');
    mkdirSync(join(sourceDir, 'Default'));
    writeFileSync(join(sourceDir, 'Default', 'Preferences'), '{}');
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    for (const dir of madeCopies.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copyProfileToTemp copies the profile recursively into a prefixed temp dir', () => {
    const copy = copyProfileToTemp(sourceDir);
    madeCopies.push(copy);

    expect(copy).not.toBe(sourceDir);
    expect(copy).toContain(TEMP_PROFILE_PREFIX);
    expect(readFileSync(join(copy, 'Cookies'), 'utf8')).toBe('cookie-bytes');
    expect(existsSync(join(copy, 'Default', 'Preferences'))).toBe(true);
  });

  it('removeTempProfile deletes a wigolo temp copy', () => {
    const copy = copyProfileToTemp(sourceDir);
    madeCopies.push(copy);
    expect(existsSync(copy)).toBe(true);

    removeTempProfile(copy);
    expect(existsSync(copy)).toBe(false);
  });

  it('removeTempProfile is a no-op for undefined', () => {
    expect(() => removeTempProfile(undefined)).not.toThrow();
  });

  it('removeTempProfile refuses to delete a directory without the wigolo prefix', () => {
    // A user-configured directory (e.g. the LIVE profile path) must never be
    // deleted, even if it is mistakenly passed in.
    removeTempProfile(sourceDir);
    expect(existsSync(sourceDir)).toBe(true);
    expect(existsSync(join(sourceDir, 'Cookies'))).toBe(true);
  });

  it('removeTempProfile tolerates an already-removed directory', () => {
    const copy = copyProfileToTemp(sourceDir);
    rmSync(copy, { recursive: true, force: true });
    expect(() => removeTempProfile(copy)).not.toThrow();
  });
});
