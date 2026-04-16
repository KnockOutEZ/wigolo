import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test the pure functions that don't depend on package root resolution
// by calling them with a temp dir.

// For functions that need the package root we test via their observable effects.

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `wigolo-utils-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mergeBlock
// ---------------------------------------------------------------------------

import { mergeBlock, removeBlock, mergeMcpJson, removeMcpJson } from '../../../../src/cli/agents/utils.js';

const BLOCK = '<!-- wigolo:start v1 -->\n## Wigolo\nContent here.\n<!-- wigolo:end -->';

describe('mergeBlock', () => {
  it('creates file with block when file does not exist', () => {
    const filePath = join(tmpDir, 'new.md');
    mergeBlock(filePath, BLOCK);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('<!-- wigolo:start');
    expect(content).toContain('<!-- wigolo:end -->');
  });

  it('creates parent directories if missing', () => {
    const filePath = join(tmpDir, 'sub', 'dir', 'new.md');
    mergeBlock(filePath, BLOCK);
    expect(existsSync(filePath)).toBe(true);
  });

  it('appends block to existing file without block', () => {
    const filePath = join(tmpDir, 'existing.md');
    writeFileSync(filePath, '# Existing content\n\nSome text here.\n', 'utf-8');
    mergeBlock(filePath, BLOCK);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Existing content');
    expect(content).toContain('<!-- wigolo:start');
  });

  it('replaces existing block', () => {
    const filePath = join(tmpDir, 'existing.md');
    const original = '# Header\n\n<!-- wigolo:start v0 -->\n## Old\n<!-- wigolo:end -->\n\n# Footer\n';
    writeFileSync(filePath, original, 'utf-8');
    mergeBlock(filePath, BLOCK);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('## Wigolo');
    expect(content).not.toContain('## Old');
    expect(content).toContain('# Header');
    expect(content).toContain('# Footer');
  });
});

// ---------------------------------------------------------------------------
// removeBlock
// ---------------------------------------------------------------------------

describe('removeBlock', () => {
  it('removes block from file, preserving surrounding content', () => {
    const filePath = join(tmpDir, 'with-block.md');
    writeFileSync(filePath, '# Header\n\n' + BLOCK + '\n\n# Footer\n', 'utf-8');
    removeBlock(filePath);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('<!-- wigolo:start');
    expect(content).not.toContain('<!-- wigolo:end -->');
    expect(content).toContain('# Header');
    expect(content).toContain('# Footer');
  });

  it('is noop when file does not exist', () => {
    expect(() => removeBlock(join(tmpDir, 'missing.md'))).not.toThrow();
  });

  it('is noop when file has no block', () => {
    const filePath = join(tmpDir, 'no-block.md');
    writeFileSync(filePath, '# No block here\n', 'utf-8');
    removeBlock(filePath);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('# No block here\n');
  });
});

// ---------------------------------------------------------------------------
// mergeMcpJson
// ---------------------------------------------------------------------------

describe('mergeMcpJson', () => {
  it('creates JSON file with entry when file does not exist', () => {
    const cfgPath = join(tmpDir, 'mcp.json');
    mergeMcpJson(cfgPath, { command: 'wigolo', args: [] }, ['mcpServers', 'wigolo']);
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(parsed.mcpServers.wigolo.command).toBe('wigolo');
  });

  it('preserves other servers when merging', () => {
    const cfgPath = join(tmpDir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2), 'utf-8');
    mergeMcpJson(cfgPath, { command: 'wigolo', args: [] }, ['mcpServers', 'wigolo']);
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(parsed.mcpServers.other.command).toBe('other');
    expect(parsed.mcpServers.wigolo.command).toBe('wigolo');
  });

  it('creates nested keys as needed', () => {
    const cfgPath = join(tmpDir, 'mcp.json');
    mergeMcpJson(cfgPath, { command: 'wigolo', args: [] }, ['a', 'b', 'c']);
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(parsed.a.b.c.command).toBe('wigolo');
  });
});

// ---------------------------------------------------------------------------
// removeMcpJson
// ---------------------------------------------------------------------------

describe('removeMcpJson', () => {
  it('removes wigolo entry and preserves other servers', () => {
    const cfgPath = join(tmpDir, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify({
      mcpServers: { wigolo: { command: 'wigolo' }, other: { command: 'other' } },
    }, null, 2), 'utf-8');
    removeMcpJson(cfgPath, ['mcpServers', 'wigolo']);
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(parsed.mcpServers.wigolo).toBeUndefined();
    expect(parsed.mcpServers.other.command).toBe('other');
  });

  it('is noop when file does not exist', () => {
    expect(() => removeMcpJson(join(tmpDir, 'missing.json'), ['mcpServers', 'wigolo'])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getMcpCommand — uses execSync which is hard to unit-test cleanly;
// we just ensure it returns a valid shape.
// ---------------------------------------------------------------------------

describe('getMcpCommand', () => {
  it('returns an object with command and args', async () => {
    const { getMcpCommand } = await import('../../../../src/cli/agents/utils.js');
    const result = getMcpCommand();
    expect(typeof result.command).toBe('string');
    expect(Array.isArray(result.args)).toBe(true);
    expect(result.command.length).toBeGreaterThan(0);
  });
});
