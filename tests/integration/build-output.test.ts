import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

describe('build output (tsup)', () => {
  beforeAll(() => {
    execSync('npm run build', { stdio: 'ignore' });
  }, 180_000);

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

  it('bundles only the MCP control plane while keeping the runtime external', () => {
    const content = readFileSync('dist/server/control.js', 'utf-8');
    expect(content.length).toBeGreaterThan(100_000);
    expect(content).toContain('import("../server.js")');
    expect(content).not.toContain('from "../instructions.js"');
    expect(content).not.toContain('from "./tool-schemas.js"');
    expect(content).not.toContain('initDatabase');
    expect(content).not.toContain('loadPlugins');
    expect(content).not.toContain('playwright-tier');
  });

  it('respects bin shebang', () => {
    const content = readFileSync('dist/index.js', 'utf-8');
    expect(content.startsWith('#!')).toBe(true);
  });
});
