import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

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

  it('ships zero Python (no dist/scripts or dist/python)', () => {
    // Phase 4 removed the Python reranker subprocess. The build no longer
    // copies any Python assets — its absence is the contract we assert.
    expect(existsSync('dist/scripts')).toBe(false);
    expect(existsSync('dist/python')).toBe(false);
  });

  it('produces sourcemaps', () => {
    expect(existsSync('dist/index.js.map')).toBe(true);
  });

  it('respects bin shebang', () => {
    const content = readFileSync('dist/index.js', 'utf-8');
    expect(content.startsWith('#!')).toBe(true);
  });
});
