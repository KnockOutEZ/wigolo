import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

describe('build output (tsup)', () => {
  beforeAll(() => {
    execSync('npm run build', { stdio: 'pipe' });
  }, 120_000);

  it('emits dist/index.js', () => {
    expect(existsSync('dist/index.js')).toBe(true);
  });

  it('emits type declarations', () => {
    expect(existsSync('dist/index.d.ts')).toBe(true);
    expect(existsSync('dist/types.d.ts')).toBe(true);
  });

  it('copies Python scripts', () => {
    expect(existsSync('dist/scripts')).toBe(true);
    const pyFiles = readdirSync('dist/scripts').filter((f) => f.endsWith('.py'));
    expect(pyFiles.length).toBeGreaterThan(0);
  });

  it('produces sourcemaps', () => {
    expect(existsSync('dist/index.js.map')).toBe(true);
  });

  it('respects bin shebang', () => {
    const content = readFileSync('dist/index.js', 'utf-8');
    expect(content.startsWith('#!')).toBe(true);
  });
});
