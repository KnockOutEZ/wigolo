import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonObject } from '../../../../src/cli/tui/config-writer-json.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

import { homedir } from 'node:os';
import { binaryInPath } from '../../../../src/cli/tui/detect-helpers.js';

vi.mock('../../../../src/cli/tui/detect-helpers.js', () => ({
  binaryInPath: vi.fn(),
}));

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `wigolo-opencode-test-${Date.now()}`);
  mkdirSync(tmpHome, { recursive: true });
  vi.mocked(homedir).mockReturnValue(tmpHome);
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('opencodeHandler.detect', () => {
  it('returns true when ~/.config/opencode exists', async () => {
    mkdirSync(join(tmpHome, '.config', 'opencode'), { recursive: true });
    const { opencodeHandler } = await import('../../../../src/cli/agents/opencode.js');
    expect(opencodeHandler.detect()).toBe(true);
  });

  it('returns true when `opencode` is on PATH', async () => {
    vi.mocked(binaryInPath).mockReturnValue('/usr/local/bin/opencode');
    const { opencodeHandler } = await import('../../../../src/cli/agents/opencode.js');
    expect(opencodeHandler.detect()).toBe(true);
  });
});

describe('opencodeHandler lifecycle', () => {
  it('writes the OpenCode local MCP schema', async () => {
    const configDir = join(tmpHome, '.config', 'opencode');
    const configPath = join(configDir, 'opencode.json');
    const legacyPath = join(configDir, 'config.json');
    mkdirSync(configDir, { recursive: true });
    const currentOriginal = `{
      // current OpenCode JSONC
      "theme": "opencode",
      "mcp": {
        "current": { "type": "remote", "url": "https://example.com/current" },
      },
    }\n`;
    const legacyOriginal = `{
      // legacy OpenCode JSONC
      "theme": "opencode",
      "mcp": {
        "other": { "type": "remote", "url": "https://example.com/mcp" },
        "wigolo": { "type": "local", "command": "npx", "args": ["-y", "wigolo"] },
      },
    }\n`;
    writeFileSync(configPath, currentOriginal);
    writeFileSync(legacyPath, legacyOriginal);

    const { opencodeHandler } = await import('../../../../src/cli/agents/opencode.js');
    await opencodeHandler.installMcp({ command: 'npx', args: ['-y', 'wigolo'] });

    const parsed = parseJsonObject(readFileSync(configPath, 'utf-8'), true);
    expect(parsed.theme).toBe('opencode');
    expect(parsed.mcp.current).toBeDefined();
    expect(parsed.mcp.wigolo).toEqual({
      type: 'local',
      command: ['npx', '-y', 'wigolo'],
      enabled: true,
    });

    const legacy = parseJsonObject(readFileSync(legacyPath, 'utf-8'), true);
    expect(legacy.theme).toBe('opencode');
    expect(legacy.mcp.other).toBeDefined();
    expect(legacy.mcp.wigolo).toBeUndefined();
    expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe(currentOriginal);
    expect(readFileSync(`${legacyPath}.bak`, 'utf-8')).toBe(legacyOriginal);
  });

  it('uninstall removes only mcp.wigolo from current and legacy global configs', async () => {
    const configDir = join(tmpHome, '.config', 'opencode');
    const configPath = join(configDir, 'opencode.json');
    const legacyPath = join(configDir, 'config.json');
    mkdirSync(configDir, { recursive: true });
    const currentOriginal = `{
      // current OpenCode JSONC
      "theme": "opencode",
      "mcp": {
        "other": { "type": "remote", "url": "https://example.com/mcp" },
        "wigolo": { "type": "local", "command": ["npx", "-y", "wigolo"], "enabled": true },
      },
    }`;
    const legacyOriginal = `{
      // legacy OpenCode JSONC
      "formatter": { "prettier": { "command": ["prettier", "--write", "$FILE"] } },
      "mcp": {
        "other": { "type": "remote", "url": "https://example.com/legacy" },
        "wigolo": { "type": "local", "command": "npx", "args": ["-y", "wigolo"] },
      },
    }`;
    writeFileSync(configPath, currentOriginal);
    writeFileSync(legacyPath, legacyOriginal);

    const { opencodeHandler } = await import('../../../../src/cli/agents/opencode.js');
    const result = await opencodeHandler.uninstall();
    const parsed = parseJsonObject(readFileSync(configPath, 'utf-8'), true);
    const legacy = parseJsonObject(readFileSync(legacyPath, 'utf-8'), true);

    expect(parsed.theme).toBe('opencode');
    expect(parsed.mcp.other).toBeDefined();
    expect(parsed.mcp.wigolo).toBeUndefined();
    expect(legacy.formatter.prettier).toBeDefined();
    expect(legacy.mcp.other).toBeDefined();
    expect(legacy.mcp.wigolo).toBeUndefined();
    expect(result.removed).toEqual([
      '~/.config/opencode/opencode.json (wigolo mcp entry)',
      '~/.config/opencode/config.json (legacy wigolo mcp entry)',
    ]);
    expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe(currentOriginal);
    expect(readFileSync(`${legacyPath}.bak`, 'utf-8')).toBe(legacyOriginal);
  });

  it('does not rewrite or report configs without a wigolo entry', async () => {
    const configDir = join(tmpHome, '.config', 'opencode');
    const configPath = join(configDir, 'opencode.json');
    mkdirSync(configDir, { recursive: true });
    const original = `{
      // preserve untouched JSONC byte-for-byte
      "theme": "opencode",
      "mcp": { "other": { "type": "remote" }, },
    }\n`;
    writeFileSync(configPath, original);

    const { opencodeHandler } = await import('../../../../src/cli/agents/opencode.js');
    await expect(opencodeHandler.uninstall()).resolves.toEqual({ removed: [] });
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('reports a malformed legacy config instead of silently claiming migration', async () => {
    const configDir = join(tmpHome, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), '{ "mcp": { "wigolo": nope } }');

    const { opencodeHandler } = await import('../../../../src/cli/agents/opencode.js');
    await expect(opencodeHandler.installMcp({ command: 'npx', args: ['-y', 'wigolo'] }))
      .rejects.toThrow('legacy OpenCode config migration failed');
  });

  it('rolls back current cleanup when legacy cleanup fails', async () => {
    const configDir = join(tmpHome, '.config', 'opencode');
    const configPath = join(configDir, 'opencode.json');
    const legacyPath = join(configDir, 'config.json');
    mkdirSync(configDir, { recursive: true });
    const currentOriginal = `{
      // keep this current config intact on rollback
      "mcp": {
        "wigolo": { "type": "local", "command": ["npx", "-y", "wigolo"], "enabled": true },
      },
    }\n`;
    writeFileSync(configPath, currentOriginal);
    writeFileSync(legacyPath, '{ "mcp": { "wigolo": nope } }');

    const { opencodeHandler } = await import('../../../../src/cli/agents/opencode.js');
    await expect(opencodeHandler.uninstall())
      .rejects.toThrow('legacy OpenCode config cleanup failed');
    expect(readFileSync(configPath, 'utf-8')).toBe(currentOriginal);
  });

  it.skipIf(process.platform === 'win32')('does not write through a symlink planted before rollback', async () => {
    const configDir = join(tmpHome, '.config', 'opencode');
    const configPath = join(configDir, 'opencode.json');
    const legacyPath = join(configDir, 'config.json');
    const victimPath = join(configDir, 'victim.txt');
    const currentOriginal = '{"theme":"system"}\n';
    const victimOriginal = 'do not overwrite\n';
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, currentOriginal);
    writeFileSync(legacyPath, '{"mcp":{"wigolo":{"type":"local"}}}\n');
    writeFileSync(victimPath, victimOriginal);

    const realCopyFile = fs.copyFile.bind(fs);
    const copySpy = vi.spyOn(fs, 'copyFile').mockImplementation(async (source, destination, mode) => {
      if (String(destination) === `${legacyPath}.bak`) {
        unlinkSync(configPath);
        symlinkSync(victimPath, configPath);
        throw new Error('simulated legacy backup failure');
      }
      if (mode === undefined) return realCopyFile(source, destination);
      return realCopyFile(source, destination, mode);
    });

    try {
      const { syncOpencodeConfig } = await import('../../../../src/cli/agents/opencode.js');
      const result = await syncOpencodeConfig({
        command: { command: 'npx', args: ['-y', 'wigolo'] },
        configPath,
        legacyConfigPath: legacyPath,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain('rollback failed: refused symbolic link config');
      expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(victimPath, 'utf-8')).toBe(victimOriginal);
      expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe(currentOriginal);
    } finally {
      copySpy.mockRestore();
    }
  });

  it('preserves a concurrent regular-file replacement instead of rolling it back', async () => {
    const configDir = join(tmpHome, '.config', 'opencode');
    const configPath = join(configDir, 'opencode.json');
    const legacyPath = join(configDir, 'config.json');
    const concurrentConfig = '{"theme":"concurrent-update"}\n';
    mkdirSync(configDir, { recursive: true });
    writeFileSync(legacyPath, '{"mcp":{"wigolo":{"type":"local"}}}\n');

    const realCopyFile = fs.copyFile.bind(fs);
    const copySpy = vi.spyOn(fs, 'copyFile').mockImplementation(async (source, destination, mode) => {
      if (String(destination) === `${legacyPath}.bak`) {
        writeFileSync(configPath, concurrentConfig);
        throw new Error('simulated legacy backup failure');
      }
      if (mode === undefined) return realCopyFile(source, destination);
      return realCopyFile(source, destination, mode);
    });

    try {
      const { syncOpencodeConfig } = await import('../../../../src/cli/agents/opencode.js');
      const result = await syncOpencodeConfig({
        command: { command: 'npx', args: ['-y', 'wigolo'] },
        configPath,
        legacyConfigPath: legacyPath,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain('rollback failed: config changed after Wigolo update');
      expect(readFileSync(configPath, 'utf-8')).toBe(concurrentConfig);
    } finally {
      copySpy.mockRestore();
    }
  });

  it('is idempotent when opencode.json is absent', async () => {
    const { opencodeHandler } = await import('../../../../src/cli/agents/opencode.js');
    await expect(opencodeHandler.uninstall()).resolves.toEqual({ removed: [] });
    expect(existsSync(join(tmpHome, '.config', 'opencode', 'opencode.json'))).toBe(false);
  });
});

describe('opencodeHandler metadata', () => {
  it('is MCP-only', async () => {
    const { opencodeHandler } = await import('../../../../src/cli/agents/opencode.js');
    expect(opencodeHandler.id).toBe('opencode');
    expect(opencodeHandler.supportsSkills).toBe(false);
    expect(opencodeHandler.supportsCommands).toBe(false);
    expect(opencodeHandler.supportsInstructions).toBe(false);
    await expect(opencodeHandler.installInstructions()).resolves.toBeUndefined();
  });
});
