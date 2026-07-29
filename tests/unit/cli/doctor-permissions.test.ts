/**
 * The doctor check must be read-only: `runDoctorColdChecks` is reused by `init`
 * and is documented as writing zero bytes, so a check that touched
 * `~/.claude/settings.json` would break that contract.
 *
 * `homedir()` is stubbed rather than set through `HOME` so the redirection is
 * scoped to this file and cannot depend on suite-wide env ordering.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

function writeSettings(value: unknown): void {
  mkdirSync(join(tmpHome, '.claude'), { recursive: true });
  writeFileSync(join(tmpHome, '.claude', 'settings.json'), JSON.stringify(value, null, 2), 'utf-8');
}

async function permissionCheck() {
  const { runDoctorColdChecks } = await import('../../../src/cli/doctor.js');
  const checks = await runDoctorColdChecks(join(tmpHome, '.wigolo'));
  const check = checks.find((c) => c.name === 'claude-code-permissions');
  expect(check, 'claude-code-permissions check is not registered').toBeDefined();
  return check!;
}

describe('doctor: claude-code-permissions', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'wigolo-doctor-perms-'));
    mkdirSync(join(tmpHome, '.wigolo'), { recursive: true });
    vi.resetModules();
  });
  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('skips when Claude Code is not installed', async () => {
    const check = await permissionCheck();
    expect(check.status).toBe('skipped');
    expect(check.detail).toMatch(/not detected/);
  });

  it('reports the missing rule as advisory, never as a failure', async () => {
    // A user who prefers to approve every call is not running a broken install,
    // so this must never colour doctor's exit code.
    writeSettings({ permissions: { allow: ['WebFetch'] } });

    const check = await permissionCheck();

    expect(check.status).toBe('skipped');
    expect(check.detail).toContain('mcp__wigolo__*');
    // The restart is the step users miss; the detail has to say so.
    expect(check.detail).toMatch(/restart Claude Code/i);
  });

  it('is never fixable — doctor --fix must not write to another app\'s config', async () => {
    writeSettings({ permissions: { allow: ['WebFetch'] } });
    expect((await permissionCheck()).fixable).toBe(false);

    writeSettings({ permissions: { allow: ['mcp__wigolo__*'] } });
    expect((await permissionCheck()).fixable).toBe(false);
  });

  it('passes on the wildcard rule', async () => {
    writeSettings({ permissions: { allow: ['mcp__wigolo__*'] } });
    expect((await permissionCheck()).status).toBe('ok');
  });

  it('passes on the bare server rule', async () => {
    writeSettings({ permissions: { allow: ['mcp__wigolo'] } });
    expect((await permissionCheck()).status).toBe('ok');
  });

  it('passes when every tool is listed literally', async () => {
    const literal = [
      'fetch', 'search', 'crawl', 'cache', 'extract',
      'find_similar', 'research', 'agent', 'diff', 'watch',
    ].map((t) => `mcp__wigolo__${t}`);
    writeSettings({ permissions: { allow: literal } });

    expect((await permissionCheck()).status).toBe('ok');
  });

  it('does not report ok when a deny rule shadows the allow rule', async () => {
    // Claude Code evaluates deny before allow, so the tools are blocked
    // despite the allow entry.
    writeSettings({ permissions: { allow: ['mcp__wigolo__*'], deny: ['mcp__wigolo__*'] } });

    const check = await permissionCheck();

    expect(check.status).toBe('skipped');
    expect(check.detail).toMatch(/deny rule/);
  });

  it('does not report ok when an ask rule shadows the allow rule', async () => {
    writeSettings({ permissions: { allow: ['mcp__wigolo__*'], ask: ['mcp__wigolo__search'] } });

    const check = await permissionCheck();

    expect(check.status).toBe('skipped');
    expect(check.detail).toMatch(/ask rule/);
  });

  it('ignores deny/ask rules aimed at other servers', async () => {
    writeSettings({
      permissions: {
        allow: ['mcp__wigolo__*'],
        deny: ['mcp__other__*', 'Read(**/.env)'],
        ask: ['Bash(rm:*)'],
      },
    });

    expect((await permissionCheck()).status).toBe('ok');
  });

  it('is not satisfied by a partial literal list', async () => {
    writeSettings({ permissions: { allow: ['mcp__wigolo__search', 'mcp__wigolo__fetch'] } });
    expect((await permissionCheck()).status).toBe('skipped');
  });

  it('reports an unreadable settings file instead of throwing', async () => {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    writeFileSync(join(tmpHome, '.claude', 'settings.json'), '{ broken', 'utf-8');

    const check = await permissionCheck();

    expect(check.status).toBe('skipped');
    expect(check.detail).toMatch(/unreadable/);
  });

  it('writes nothing — the check is read-only', async () => {
    const original = { permissions: { allow: ['WebFetch'] } };
    writeSettings(original);
    const before = readFileSync(join(tmpHome, '.claude', 'settings.json'), 'utf-8');

    await permissionCheck();

    expect(readFileSync(join(tmpHome, '.claude', 'settings.json'), 'utf-8')).toBe(before);
  });
});
