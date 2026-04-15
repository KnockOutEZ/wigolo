import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { writeTomlConfig } from '../../../../src/cli/tui/config-writer-toml.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wigolo-toml-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeTomlConfig', () => {
  it('creates a new file with the wigolo entry', async () => {
    const path = join(dir, 'config.toml');
    const r = await writeTomlConfig({
      path,
      tablePath: ['mcp_servers', 'wigolo'],
      entry: { command: 'npx', args: ['-y', '@staticn0va/wigolo'] },
    });
    expect(r.ok).toBe(true);
    const parsed = parseToml(readFileSync(path, 'utf-8')) as any;
    expect(parsed.mcp_servers.wigolo.command).toBe('npx');
    expect(parsed.mcp_servers.wigolo.args).toEqual(['-y', '@staticn0va/wigolo']);
  });

  it('merges into an existing config preserving other tables', async () => {
    const path = join(dir, 'config.toml');
    writeFileSync(path, [
      '[model]',
      'name = "gpt-4"',
      '',
      '[mcp_servers.other]',
      'command = "node"',
      'args = ["other.js"]',
      '',
    ].join('\n'));
    const r = await writeTomlConfig({
      path,
      tablePath: ['mcp_servers', 'wigolo'],
      entry: { command: 'npx', args: ['-y', '@staticn0va/wigolo'] },
    });
    expect(r.ok).toBe(true);
    const parsed = parseToml(readFileSync(path, 'utf-8')) as any;
    expect(parsed.model.name).toBe('gpt-4');
    expect(parsed.mcp_servers.other.command).toBe('node');
    expect(parsed.mcp_servers.wigolo.command).toBe('npx');
  });

  it('overwrites an existing wigolo entry', async () => {
    const path = join(dir, 'config.toml');
    writeFileSync(path, '[mcp_servers.wigolo]\ncommand = "old"\nargs = []\n');
    await writeTomlConfig({
      path,
      tablePath: ['mcp_servers', 'wigolo'],
      entry: { command: 'npx', args: ['-y', '@staticn0va/wigolo'] },
    });
    const parsed = parseToml(readFileSync(path, 'utf-8')) as any;
    expect(parsed.mcp_servers.wigolo.command).toBe('npx');
  });

  it('writes a .bak file when target exists', async () => {
    const path = join(dir, 'config.toml');
    writeFileSync(path, '[other]\nkey = "val"\n');
    await writeTomlConfig({
      path,
      tablePath: ['mcp_servers', 'wigolo'],
      entry: { command: 'npx', args: [] },
    });
    expect(existsSync(`${path}.bak`)).toBe(true);
  });

  it('returns PARSE_ERROR for malformed TOML', async () => {
    const path = join(dir, 'config.toml');
    writeFileSync(path, '[unterminated table\nkey = ');
    const r = await writeTomlConfig({
      path,
      tablePath: ['mcp_servers', 'wigolo'],
      entry: { command: 'npx', args: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARSE_ERROR');
  });

  it('honors dryRun: returns ok=true and writes nothing', async () => {
    const path = join(dir, 'config.toml');
    const r = await writeTomlConfig({
      path,
      tablePath: ['mcp_servers', 'wigolo'],
      entry: { command: 'npx', args: [] },
      dryRun: true,
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('creates intermediate directories', async () => {
    const path = join(dir, 'nested', 'codex', 'config.toml');
    const r = await writeTomlConfig({
      path,
      tablePath: ['mcp_servers', 'wigolo'],
      entry: { command: 'npx', args: [] },
    });
    expect(r.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});
