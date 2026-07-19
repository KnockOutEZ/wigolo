import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeJsonConfigEntry, writeJsonConfig } from '../../../../src/cli/tui/config-writer-json.js';

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
      entry: { command: 'npx', args: ['-y', 'wigolo'] },
    });
    expect(r.ok).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content).toEqual({ mcpServers: { wigolo: { command: 'npx', args: ['-y', 'wigolo'] } } });
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
      entry: { command: 'npx', args: ['-y', 'wigolo'] },
    });
    expect(r.ok).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.mcpServers.other).toEqual({ command: 'node', args: ['other.js'] });
    expect(content.mcpServers.wigolo).toEqual({ command: 'npx', args: ['-y', 'wigolo'] });
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
      entry: { command: 'npx', args: ['-y', 'wigolo'] },
    });
    expect(r.ok).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.mcpServers.wigolo.command).toBe('npx');
  });

  it('accepts JSONC when explicitly enabled and preserves semantic content', async () => {
    const path = join(dir, 'opencode.json');
    const original = `{
  // OpenCode accepts comments and trailing commas.
  "theme": "system",
  "mcp": {
    "other": { "type": "remote", "url": "https://example.com/mcp" },
  },
}\n`;
    writeFileSync(path, original);

    const r = await writeJsonConfig({
      path,
      keyPath: ['mcp', 'wigolo'],
      entry: { type: 'local', command: ['npx', '-y', 'wigolo'], enabled: true },
      allowJsonc: true,
      requireBackup: true,
    });

    expect(r.ok).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.theme).toBe('system');
    expect(content.mcp.other).toBeDefined();
    expect(content.mcp.wigolo.command).toEqual(['npx', '-y', 'wigolo']);
    expect(readFileSync(`${path}.bak`, 'utf-8')).toBe(original);
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

  it('does not replace an existing config when a required backup fails', async () => {
    const path = join(dir, 'opencode.json');
    const original = '{"theme":"system"}\n';
    writeFileSync(path, original);
    mkdirSync(`${path}.bak`);

    const r = await writeJsonConfig({
      path,
      keyPath: ['mcp', 'wigolo'],
      entry: { type: 'local', command: ['npx', '-y', 'wigolo'], enabled: true },
      allowJsonc: true,
      requireBackup: true,
    });

    expect(r.ok).toBe(false);
    expect(r.code).toBe('WRITE_FAILED');
    expect(r.message).toContain('back up existing config');
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  it.skipIf(process.platform === 'win32')('preserves existing file permissions during atomic replacement', async () => {
    const path = join(dir, 'opencode.json');
    writeFileSync(path, '{"theme":"system"}\n');
    chmodSync(path, 0o660);

    const previousUmask = process.umask(0o027);
    let r;
    try {
      r = await writeJsonConfig({
        path,
        keyPath: ['mcp', 'wigolo'],
        entry: { type: 'local', command: ['npx', '-y', 'wigolo'], enabled: true },
        allowJsonc: true,
        requireBackup: true,
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(r.ok).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o660);
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

describe('removeJsonConfigEntry', () => {
  it('removes an entry from JSONC and preserves other semantic content', async () => {
    const path = join(dir, 'config.json');
    const original = `{
  // legacy OpenCode config
  "theme": "system",
  "mcp": {
    "other": { "type": "remote", "url": "https://example.com/mcp" },
    "wigolo": { "type": "local", "command": "npx", "args": ["-y", "wigolo"] },
  },
}\n`;
    writeFileSync(path, original);

    const r = await removeJsonConfigEntry({
      path,
      keyPath: ['mcp', 'wigolo'],
      allowJsonc: true,
      requireBackup: true,
    });

    expect(r).toMatchObject({ ok: true, code: 'OK', removed: true });
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.theme).toBe('system');
    expect(content.mcp.other).toBeDefined();
    expect(content.mcp.wigolo).toBeUndefined();
    expect(readFileSync(`${path}.bak`, 'utf-8')).toBe(original);
  });

  it('does not remove an entry when a required backup fails', async () => {
    const path = join(dir, 'config.json');
    const original = '{"mcp":{"wigolo":{"type":"local"}}}\n';
    writeFileSync(path, original);
    mkdirSync(`${path}.bak`);

    const r = await removeJsonConfigEntry({
      path,
      keyPath: ['mcp', 'wigolo'],
      allowJsonc: true,
      requireBackup: true,
    });

    expect(r.ok).toBe(false);
    expect(r.removed).toBe(false);
    expect(r.message).toContain('back up existing config');
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  it('does not rewrite or back up a file when the entry is absent', async () => {
    const path = join(dir, 'opencode.json');
    const original = '{\n  // keep this comment\n  "theme": "system",\n}\n';
    writeFileSync(path, original);

    const r = await removeJsonConfigEntry({
      path,
      keyPath: ['mcp', 'wigolo'],
      allowJsonc: true,
    });

    expect(r).toMatchObject({ ok: true, code: 'OK', removed: false });
    expect(readFileSync(path, 'utf-8')).toBe(original);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it('treats an empty config as an object with no matching entry', async () => {
    const path = join(dir, 'empty.json');
    writeFileSync(path, '');

    const r = await removeJsonConfigEntry({
      path,
      keyPath: ['mcp', 'wigolo'],
      allowJsonc: true,
    });

    expect(r).toMatchObject({ ok: true, code: 'OK', removed: false });
    expect(readFileSync(path, 'utf-8')).toBe('');
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it('reports a JSONC parse error instead of silently skipping migration', async () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, '{ "mcp": { "wigolo": nope } }');

    const r = await removeJsonConfigEntry({
      path,
      keyPath: ['mcp', 'wigolo'],
      allowJsonc: true,
    });

    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARSE_ERROR');
  });
});
