import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import {
  runPluginAdd,
  runPluginList,
  runPluginRemove,
  runPluginCommand,
} from '../../../src/cli/plugin.js';

describe('runPluginAdd', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WIGOLO_PLUGINS_DIR = '/tmp/test-plugins';
    resetConfig();
    vi.clearAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('clones a git repo into the plugins directory', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    runPluginAdd('https://github.com/user/wigolo-plugin-example.git');

    expect(mkdirSync).toHaveBeenCalledWith('/tmp/test-plugins', { recursive: true });
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('git clone'),
      expect.objectContaining({ cwd: '/tmp/test-plugins' }),
    );
  });

  it('extracts repo name from git URL for the clone directory', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    runPluginAdd('https://github.com/user/my-plugin.git');

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('my-plugin'),
      expect.anything(),
    );
  });

  it('extracts repo name from URL without .git suffix', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    runPluginAdd('https://github.com/user/no-git-suffix');

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('no-git-suffix'),
      expect.anything(),
    );
  });

  it('throws if plugin directory already exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    expect(() => runPluginAdd('https://github.com/user/my-plugin.git')).toThrow(
      /already exists/i,
    );
  });

  it('throws on git clone failure', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('fatal: repository not found');
    });

    expect(() => runPluginAdd('https://github.com/user/nonexistent.git')).toThrow(
      /clone failed/i,
    );
  });

  it('throws on empty git URL', () => {
    expect(() => runPluginAdd('')).toThrow(/url/i);
  });

  it('throws on malformed git URL without path segments', () => {
    expect(() => runPluginAdd('not-a-url')).toThrow();
  });

  it('handles SSH-style git URLs (git@github.com:user/repo.git)', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    runPluginAdd('git@github.com:user/ssh-plugin.git');

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('ssh-plugin'),
      expect.anything(),
    );
  });
});

describe('runPluginList', () => {
  const originalEnv = process.env;
  let stderrOutput: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WIGOLO_PLUGINS_DIR = '/tmp/test-plugins';
    resetConfig();
    vi.clearAllMocks();
    stderrOutput = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += String(chunk);
      return true;
    });
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.restoreAllMocks();
  });

  it('lists installed plugins with name and version', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['plugin-a', 'plugin-b'] as any);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false } as any);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).includes('plugin-a')) {
        return JSON.stringify({ name: 'plugin-a', version: '1.0.0', main: 'index.mjs' });
      }
      return JSON.stringify({ name: 'plugin-b', version: '2.3.0', main: 'index.mjs' });
    });

    runPluginList();

    expect(stderrOutput).toContain('plugin-a');
    expect(stderrOutput).toContain('1.0.0');
    expect(stderrOutput).toContain('plugin-b');
    expect(stderrOutput).toContain('2.3.0');
  });

  it('shows a message when no plugins are installed', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    runPluginList();

    expect(stderrOutput).toContain('no plugins');
  });

  it('handles empty plugins directory', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([] as any);

    runPluginList();

    expect(stderrOutput).toContain('no plugins');
  });

  it('skips non-directory entries', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['file.txt', 'plugin-a'] as any);
    vi.mocked(statSync).mockImplementation((p) => {
      if (String(p).includes('file.txt')) {
        return { isDirectory: () => false, isSymbolicLink: () => false } as any;
      }
      return { isDirectory: () => true, isSymbolicLink: () => false } as any;
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ name: 'plugin-a', version: '1.0.0', main: 'index.mjs' }),
    );

    runPluginList();

    expect(stderrOutput).toContain('plugin-a');
    expect(stderrOutput).not.toContain('file.txt');
  });

  it('handles plugin with malformed package.json gracefully', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['bad-plugin'] as any);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false } as any);
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('parse error'); });

    runPluginList();

    expect(stderrOutput).toContain('bad-plugin');
  });
});

describe('runPluginRemove', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WIGOLO_PLUGINS_DIR = '/tmp/test-plugins';
    resetConfig();
    vi.clearAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('removes the plugin directory', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(rmSync).mockReturnValue(undefined);

    runPluginRemove('my-plugin');

    expect(rmSync).toHaveBeenCalledWith(
      expect.stringContaining('my-plugin'),
      { recursive: true, force: true },
    );
  });

  it('throws when plugin does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(() => runPluginRemove('nonexistent')).toThrow(/not found/i);
  });

  it('throws on empty name', () => {
    expect(() => runPluginRemove('')).toThrow(/name/i);
  });

  it('prevents path traversal in plugin name', () => {
    expect(() => runPluginRemove('../etc')).toThrow(/invalid/i);
  });

  it('prevents absolute path in plugin name', () => {
    expect(() => runPluginRemove('/etc/passwd')).toThrow(/invalid/i);
  });

  it('handles plugin names with dashes and underscores', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(rmSync).mockReturnValue(undefined);

    runPluginRemove('my-cool_plugin');

    expect(rmSync).toHaveBeenCalledWith(
      expect.stringContaining('my-cool_plugin'),
      expect.anything(),
    );
  });

  it('throws on removal failure', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(rmSync).mockImplementation(() => { throw new Error('EACCES'); });

    expect(() => runPluginRemove('locked-plugin')).toThrow(/remove.*failed/i);
  });
});

describe('runPluginCommand -- dispatcher', () => {
  const originalEnv = process.env;
  let stderrOutput: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WIGOLO_PLUGINS_DIR = '/tmp/test-plugins';
    resetConfig();
    vi.clearAllMocks();
    stderrOutput = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += String(chunk);
      return true;
    });
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.restoreAllMocks();
  });

  it('routes "add" subcommand', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    runPluginCommand(['add', 'https://github.com/user/repo.git']);

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('git clone'),
      expect.anything(),
    );
  });

  it('routes "list" subcommand', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    runPluginCommand(['list']);

    expect(stderrOutput).toContain('no plugins');
  });

  it('routes "remove" subcommand', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(rmSync).mockReturnValue(undefined);

    runPluginCommand(['remove', 'my-plugin']);

    expect(rmSync).toHaveBeenCalled();
  });

  it('shows usage for unknown subcommand', () => {
    runPluginCommand(['unknown']);

    expect(stderrOutput).toContain('Usage');
  });

  it('shows usage when no args provided', () => {
    runPluginCommand([]);

    expect(stderrOutput).toContain('Usage');
  });
});
