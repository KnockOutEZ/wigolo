import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonConfig } from '../../../../src/cli/tui/config-writer-json.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wigolo-cfg-'));
});

afterEach(() => {
  try { chmodSync(dir, 0o755); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe('writeJsonConfig', () => {
  it('creates a new file when none exists', async () => {
    const path = join(dir, 'mcp.json');
    const r = await writeJsonConfig({
      path,
      keyPath: ['mcpServers', 'wigolo'],
      entry: { command: 'npx', args: ['-y', '@staticn0va/wigolo'] },
    });
    expect(r.ok).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content).toEqual({ mcpServers: { wigolo: { command: 'npx', args: ['-y', '@staticn0va/wigolo'] } } });
  });

  it('creates intermediate directories when missing', async () => {
    const path = join(dir, 'nested', 'deep', 'mcp.json');
    const r = await writeJsonConfig({
      path,
      keyPath: ['mcpServers', 'wigolo'],
      entry: { command: 'npx', args: [] },
    });
    expect(r.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('merges into an existing config preserving other entries', async () => {
    const path = join(dir, 'mcp.json');
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        other: { command: 'node', args: ['other.js'] },
      },
      extraKey: 'preserve me',
    }, null, 2));
    const r = await writeJsonConfig({
      path,
      keyPath: ['mcpServers', 'wigolo'],
      entry: { command: 'npx', args: ['-y', '@staticn0va/wigolo'] },
    });
    expect(r.ok).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.mcpServers.other).toEqual({ command: 'node', args: ['other.js'] });
    expect(content.mcpServers.wigolo).toEqual({ command: 'npx', args: ['-y', '@staticn0va/wigolo'] });
    expect(content.extraKey).toBe('preserve me');
  });

  it('overwrites an existing wigolo entry (re-install)', async () => {
    const path = join(dir, 'mcp.json');
    writeFileSync(path, JSON.stringify({
      mcpServers: { wigolo: { command: 'old', args: ['stale'] } },
    }, null, 2));
    const r = await writeJsonConfig({
      path,
      keyPath: ['mcpServers', 'wigolo'],
      entry: { command: 'npx', args: ['-y', '@staticn0va/wigolo'] },
    });
    expect(r.ok).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.mcpServers.wigolo.command).toBe('npx');
  });

  it('writes a .bak file when the target already exists', async () => {
    const path = join(dir, 'mcp.json');
    const original = JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }, null, 2);
    writeFileSync(path, original);
    await writeJsonConfig({
      path,
      keyPath: ['mcpServers', 'wigolo'],
      entry: { command: 'npx', args: [] },
    });
    expect(existsSync(`${path}.bak`)).toBe(true);
    expect(readFileSync(`${path}.bak`, 'utf-8')).toBe(original);
  });

  it('does not write a .bak file when the target does not exist', async () => {
    const path = join(dir, 'mcp.json');
    await writeJsonConfig({
      path,
      keyPath: ['mcpServers', 'wigolo'],
      entry: { command: 'npx', args: [] },
    });
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('returns code=PERMISSION_DENIED when target dir is not writable', async () => {
    const lockedDir = join(dir, 'locked');
    mkdirSync(lockedDir);
    chmodSync(lockedDir, 0o500);
    const path = join(lockedDir, 'mcp.json');
    const r = await writeJsonConfig({
      path,
      keyPath: ['mcpServers', 'wigolo'],
      entry: { command: 'npx', args: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PERMISSION_DENIED');
    chmodSync(lockedDir, 0o755);
  });

  it('returns code=PARSE_ERROR when existing file is not valid JSON', async () => {
    const path = join(dir, 'mcp.json');
    writeFileSync(path, '{ this is not json');
    const r = await writeJsonConfig({
      path,
      keyPath: ['mcpServers', 'wigolo'],
      entry: { command: 'npx', args: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARSE_ERROR');
  });

  it('honors dryRun: returns ok=true and writes nothing', async () => {
    const path = join(dir, 'mcp.json');
    const r = await writeJsonConfig({
      path,
      keyPath: ['mcpServers', 'wigolo'],
      entry: { command: 'npx', args: [] },
      dryRun: true,
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('writes atomically via .tmp + rename', async () => {
    const path = join(dir, 'mcp.json');
    await writeJsonConfig({
      path,
      keyPath: ['mcpServers', 'wigolo'],
      entry: { command: 'npx', args: [] },
    });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it('supports a top-level keyPath of length 1', async () => {
    const path = join(dir, 'cfg.json');
    const r = await writeJsonConfig({
      path,
      keyPath: ['wigolo'],
      entry: { command: 'npx', args: [] },
    });
    expect(r.ok).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.wigolo.command).toBe('npx');
  });
});
