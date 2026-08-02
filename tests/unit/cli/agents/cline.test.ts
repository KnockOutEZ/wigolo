import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpHome: string;
let tmpCwd: string;
let tmpData: string;
let origCwd: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => tmpHome) };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error('not found');
  }),
}));

vi.mock('../../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: tmpData })),
}));

import { execSync } from 'node:child_process';

async function load() {
  return import('../../../../src/cli/agents/cline.js');
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `wigolo-cline-home-${stamp}`);
  tmpCwd = join(tmpdir(), `wigolo-cline-cwd-${stamp}`);
  tmpData = join(tmpdir(), `wigolo-cline-data-${stamp}`);
  for (const d of [tmpHome, tmpCwd, tmpData]) mkdirSync(d, { recursive: true });
  origCwd = process.cwd();
  process.chdir(tmpCwd);
  // Reset the execSync impl each test — clearAllMocks keeps a prior
  // mockReturnValue, which would leak the PATH-hit into must-not-fire.
  vi.mocked(execSync).mockReset();
  vi.mocked(execSync).mockImplementation(() => {
    throw new Error('not found');
  });
  vi.resetModules();
});

afterEach(() => {
  process.chdir(origCwd);
  for (const d of [tmpHome, tmpCwd, tmpData]) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('clineHandler.detect — fires', () => {
  it('true when cwd has a .clinerules file', async () => {
    writeFileSync(join(tmpCwd, '.clinerules'), 'rules', 'utf-8');
    const { clineHandler } = await load();
    expect(clineHandler.detect()).toBe(true);
  });

  it('true when cwd has a .cline/ dir', async () => {
    mkdirSync(join(tmpCwd, '.cline'), { recursive: true });
    const { clineHandler } = await load();
    expect(clineHandler.detect()).toBe(true);
  });

  it('true when ~/.cline exists', async () => {
    mkdirSync(join(tmpHome, '.cline'), { recursive: true });
    const { clineHandler } = await load();
    expect(clineHandler.detect()).toBe(true);
  });

  it('true when ~/Documents/Cline exists', async () => {
    mkdirSync(join(tmpHome, 'Documents', 'Cline'), { recursive: true });
    const { clineHandler } = await load();
    expect(clineHandler.detect()).toBe(true);
  });

  it('true when `cline` binary is on PATH', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('/usr/bin/cline'));
    const { clineHandler } = await load();
    expect(clineHandler.detect()).toBe(true);
  });
});

describe('clineHandler.detect — must NOT fire', () => {
  it('false on a clean temp HOME + clean cwd + no binary', async () => {
    // No markers anywhere; execSync throws (mocked).
    const { clineHandler } = await load();
    expect(clineHandler.detect()).toBe(false);
  });
});

describe('clineHandler metadata + no-ops', () => {
  it('supportsSkills=true, supportsCommands=false', async () => {
    const { clineHandler } = await load();
    expect(clineHandler.id).toBe('cline');
    expect(clineHandler.supportsSkills).toBe(true);
    expect(clineHandler.supportsCommands).toBe(false);
  });

  it('installMcp + installInstructions are silent no-ops (write nothing, no throw)', async () => {
    const { clineHandler } = await load();
    await expect(
      clineHandler.installMcp({ command: 'npx', args: ['-y', 'wigolo'] }),
    ).resolves.toBeUndefined();
    await expect(clineHandler.installInstructions()).resolves.toBeUndefined();
    // No config files created anywhere.
    expect(existsSync(join(tmpCwd, '.cline', 'mcp.json'))).toBe(false);
  });

  it('uninstall returns { removed: [] }', async () => {
    const { clineHandler } = await load();
    expect(await clineHandler.uninstall()).toEqual({ removed: [] });
  });

  it('installSkills delegates to the engine and writes ~/.cline/skills packs', async () => {
    const { clineHandler } = await load();
    await clineHandler.installSkills!();
    expect(existsSync(join(tmpHome, '.cline', 'skills', 'wigolo', 'SKILL.md'))).toBe(true);
  });
});
