import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

import { runCommand } from '../../../../src/cli/tui/run-command.js';
import { homedir } from 'node:os';
import { installViaClaudeCli } from '../../../../src/cli/tui/config-writer-cli.js';

let tmpHome: string;

afterEach(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe('installViaClaudeCli', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs `claude mcp add wigolo --scope user -- npx -y wigolo` on success', async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: 'added', stderr: '', timedOut: false });
    const r = await installViaClaudeCli();
    // --scope user is load-bearing: without it `claude mcp add` defaults to the
    // project/local scope, so wigolo only registers for the cwd where init ran
    // (missing from the user's global MCP list). Must match the fallback, which
    // writes to ~/.claude.json top-level (user scope).
    expect(runCommand).toHaveBeenCalledWith(
      'claude',
      ['mcp', 'add', 'wigolo', '--scope', 'user', '--', 'npx', '-y', 'wigolo'],
      expect.any(Object),
    );
    expect(r.ok).toBe(true);
    expect(r.alreadyInstalled).toBe(false);
  });

  it('returns alreadyInstalled=true when stderr says "already exists"', async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 1, stdout: '', stderr: 'wigolo already exists', timedOut: false });
    const r = await installViaClaudeCli();
    expect(r.ok).toBe(true);
    expect(r.alreadyInstalled).toBe(true);
  });

  it('returns ok=false on other non-zero exit', async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 2, stdout: '', stderr: 'unknown command', timedOut: false });
    const r = await installViaClaudeCli();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('unknown command');
  });

  it('falls back to writing ~/.claude.json when the claude binary is missing', async () => {
    // Re-route homedir into a temp dir so we can inspect the file safely.
    tmpHome = join(tmpdir(), `wigolo-cli-fallback-${Date.now()}`);
    mkdirSync(tmpHome, { recursive: true });
    vi.mocked(homedir).mockReturnValue(tmpHome);

    vi.mocked(runCommand).mockRejectedValue(
      Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
    );

    const r = await installViaClaudeCli();
    expect(r.ok).toBe(true);
    expect(r.code).toBe('OK_FALLBACK');
    expect(r.usedFallback).toBe(true);
    expect(r.fallbackPath).toBe(join(tmpHome, '.claude.json'));

    expect(existsSync(join(tmpHome, '.claude.json'))).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpHome, '.claude.json'), 'utf-8'));
    expect(parsed.mcpServers.wigolo.command).toBe('npx');
    expect(parsed.mcpServers.wigolo.args).toEqual(['-y', 'wigolo']);
  });

  it('respects dryRun (does not call runCommand)', async () => {
    const r = await installViaClaudeCli({ dryRun: true });
    expect(runCommand).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
  });
});
