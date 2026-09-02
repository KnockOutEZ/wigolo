import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../../../src/cli/config.js';
import { buildAuthenticatedOriginLine } from '../../../src/cli/doctor.js';
import { AUTHENTICATED_ORIGINS_KEY, ANONYMOUS_ORIGINS_KEY } from '../../../src/companion/auth-origin-store.js';

/**
 * S9 / F5 — the HUMAN-ONLY override surface.
 *
 * These flags decide whether the agent gets stopped for consent before spending the user's signed-in
 * identity on a site. `wigolo config` is the right home for them precisely because it carries a hard
 * invariant that it is never reachable from the MCP stdio path — the agent has no way to call it.
 */

let dir: string;
let originalEnv: NodeJS.ProcessEnv;
let stdout: string;

beforeEach(() => {
  originalEnv = process.env;
  dir = mkdtempSync(join(tmpdir(), 'wig-cfgorigin-'));
  process.env = { ...originalEnv, WIGOLO_CONFIG_PATH: join(dir, 'config.json') };
  stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { stdout += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function settings(): Record<string, unknown> {
  return (JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as { settings: Record<string, unknown> }).settings;
}

describe('wigolo config --authenticated-origin / --anonymous-origin', () => {
  it('persists a human authenticated mark', async () => {
    expect(await runConfig(['--authenticated-origin', 'https://example.com'])).toBe(0);
    expect(settings()[AUTHENTICATED_ORIGINS_KEY]).toEqual(['https://example.com']);
  });

  it('accepts the --flag=value form too', async () => {
    expect(await runConfig(['--anonymous-origin=https://example.com'])).toBe(0);
    expect(settings()[ANONYMOUS_ORIGINS_KEY]).toEqual(['https://example.com']);
  });

  it('normalizes a pasted URL down to its origin — users paste the page they were looking at', async () => {
    expect(await runConfig(['--authenticated-origin', 'https://example.com/settings/profile?tab=1'])).toBe(0);
    expect(settings()[AUTHENTICATED_ORIGINS_KEY]).toEqual(['https://example.com']);
  });

  it('flipping a mark removes it from the other list, so the answer never depends on clause order', async () => {
    await runConfig(['--authenticated-origin', 'https://example.com']);
    await runConfig(['--anonymous-origin', 'https://example.com']);
    expect(settings()[AUTHENTICATED_ORIGINS_KEY]).toEqual([]);
    expect(settings()[ANONYMOUS_ORIGINS_KEY]).toEqual(['https://example.com']);
  });

  it('exits non-zero on a bare hostname rather than persisting something that will never match', async () => {
    expect(await runConfig(['--authenticated-origin', 'example.com'])).toBe(1);
  });

  it('leaves unrelated settings alone (merge-patch, not overwrite)', async () => {
    const { writePersistedConfig } = await import('../../../src/persisted-config.js');
    writePersistedConfig(join(dir, 'config.json'), { settings: { unrelated: 'keep-me' } });
    await runConfig(['--authenticated-origin', 'https://example.com']);
    expect(settings().unrelated).toBe('keep-me');
    expect(settings()[AUTHENTICATED_ORIGINS_KEY]).toEqual(['https://example.com']);
  });
});

describe('doctor reports a count, never the list', () => {
  it('the reported line carries the number and no origin', () => {
    const line = buildAuthenticatedOriginLine(3);
    expect(line).toContain('3');
    expect(line).not.toMatch(/https?:\/\/(?!$)[a-z]/);
  });

  it('says count-only in plain words, so nobody later "improves" it by printing the list', () => {
    expect(buildAuthenticatedOriginLine(0)).toContain('count only');
  });
});
