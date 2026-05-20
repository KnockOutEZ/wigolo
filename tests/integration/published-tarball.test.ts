import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('published tarball contents', () => {
  let tarballPath: string;
  let extractDir: string;

  beforeAll(() => {
    const npmCache = mkdtempSync(join(tmpdir(), 'npm-cache-'));
    execSync('rm -rf dist *.tgz', { cwd: process.cwd() });
    execSync(`npm pack --cache ${npmCache}`, { cwd: process.cwd(), stdio: 'pipe' });
    const tarballs = readdirSync(process.cwd()).filter(f => f.endsWith('.tgz'));
    expect(tarballs.length).toBeGreaterThan(0);
    tarballPath = join(process.cwd(), tarballs[0]);
    extractDir = mkdtempSync(join(tmpdir(), 'wigolo-tarball-'));
    execSync(`tar -xzf ${tarballPath} -C ${extractDir}`);
  });

  it('contains dist/scripts/*.py', () => {
    const scriptsDir = join(extractDir, 'package', 'dist', 'scripts');
    expect(existsSync(scriptsDir)).toBe(true);
    const files = readdirSync(scriptsDir);
    const pyFiles = files.filter(f => f.endsWith('.py'));
    expect(pyFiles.length).toBeGreaterThan(0);
  });

  it('contains compiled JS entry point', () => {
    expect(existsSync(join(extractDir, 'package', 'dist', 'index.js'))).toBe(true);
  });
});
