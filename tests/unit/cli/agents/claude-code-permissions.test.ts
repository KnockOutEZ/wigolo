/**
 * `~/.claude/settings.json` is the user's own file and holds far more than
 * wigolo's allow rule, so every assertion here is about NOT damaging it:
 * unrelated keys survive, an existing allow list survives, a re-run adds
 * nothing, and uninstall takes back exactly one string.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { mergeJsonArray, removeJsonArrayValues } from '../../../../src/cli/agents/utils.js';

const RULE = 'mcp__wigolo__*';

let tmpHome: string;
let settingsPath: string;

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
}

function allowList(): string[] {
  const s = readSettings() as { permissions?: { allow?: string[] } };
  return s.permissions?.allow ?? [];
}

function writeSettings(value: unknown): void {
  mkdirSync(join(tmpHome, '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(value, null, 2), 'utf-8');
}

describe('claude-code tool permissions', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'wigolo-cc-perms-'));
    settingsPath = join(tmpHome, '.claude', 'settings.json');
  });
  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('creates the file and the nested path when nothing exists', () => {
    const added = mergeJsonArray(settingsPath, ['permissions', 'allow'], [RULE]);
    expect(added).toEqual([RULE]);
    expect(allowList()).toEqual([RULE]);
  });

  it('appends to an existing allow list without disturbing its entries', () => {
    writeSettings({ permissions: { allow: ['Bash(ls:*)', 'WebFetch'], deny: ['Read(**/.env)'] } });

    mergeJsonArray(settingsPath, ['permissions', 'allow'], [RULE]);

    expect(allowList()).toEqual(['Bash(ls:*)', 'WebFetch', RULE]);
    const s = readSettings() as { permissions: { deny: string[] } };
    expect(s.permissions.deny).toEqual(['Read(**/.env)']);
  });

  it('preserves unrelated top-level settings', () => {
    writeSettings({ model: 'opus', hooks: { Stop: [{ matcher: '*' }] }, permissions: { allow: [] } });

    mergeJsonArray(settingsPath, ['permissions', 'allow'], [RULE]);

    const s = readSettings() as { model: string; hooks: unknown };
    expect(s.model).toBe('opus');
    expect(s.hooks).toEqual({ Stop: [{ matcher: '*' }] });
  });

  it('is a no-op on re-run — no duplicate rule', () => {
    mergeJsonArray(settingsPath, ['permissions', 'allow'], [RULE]);
    const second = mergeJsonArray(settingsPath, ['permissions', 'allow'], [RULE]);

    expect(second).toEqual([]);
    expect(allowList()).toEqual([RULE]);
  });

  it('refuses to overwrite a settings file it cannot parse', () => {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ this is not json', 'utf-8');

    expect(() => mergeJsonArray(settingsPath, ['permissions', 'allow'], [RULE])).toThrow(
      /not valid JSON/,
    );
    // The unparseable original is still on disk, untouched.
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ this is not json');
  });

  it('uninstall removes only wigolo\'s rule', () => {
    writeSettings({ permissions: { allow: ['Bash(ls:*)', RULE, 'WebFetch'] } });

    const removed = removeJsonArrayValues(settingsPath, ['permissions', 'allow'], [RULE]);

    expect(removed).toEqual([RULE]);
    expect(allowList()).toEqual(['Bash(ls:*)', 'WebFetch']);
  });

  it('uninstall is a no-op when the rule was never there', () => {
    writeSettings({ permissions: { allow: ['WebFetch'] } });

    const removed = removeJsonArrayValues(settingsPath, ['permissions', 'allow'], [RULE]);

    expect(removed).toEqual([]);
    expect(allowList()).toEqual(['WebFetch']);
  });

  it('uninstall on a missing file does nothing and creates nothing', () => {
    const removed = removeJsonArrayValues(settingsPath, ['permissions', 'allow'], [RULE]);

    expect(removed).toEqual([]);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('refuses a settings file that is not a JSON object', () => {
    // An array parses fine but JSON.stringify would drop the key we added,
    // so the write must not report success.
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '["not", "an", "object"]', 'utf-8');

    expect(() => mergeJsonArray(settingsPath, ['permissions', 'allow'], [RULE])).toThrow(
      /not a JSON object/,
    );
    expect(readFileSync(settingsPath, 'utf-8')).toBe('["not", "an", "object"]');
  });

  it('refuses to walk into Object.prototype', () => {
    expect(() => mergeJsonArray(settingsPath, ['__proto__', 'allow'], [RULE])).toThrow(
      /reserved key/,
    );
    expect(({} as Record<string, unknown>).allow).toBeUndefined();
  });

  it('preserves a hardened file mode across the atomic rename', () => {
    // The rename swaps inodes, so without an explicit chmod the destination
    // would come back at the umask default and silently widen the user's
    // permissions.
    writeSettings({ permissions: { allow: ['WebFetch'] } });
    chmodSync(settingsPath, 0o600);

    mergeJsonArray(settingsPath, ['permissions', 'allow'], [RULE]);

    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(allowList()).toEqual(['WebFetch', RULE]);
  });

  it('preserves the file mode on removal too', () => {
    writeSettings({ permissions: { allow: ['WebFetch', RULE] } });
    chmodSync(settingsPath, 0o600);

    removeJsonArrayValues(settingsPath, ['permissions', 'allow'], [RULE]);

    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind after a successful write', () => {
    mergeJsonArray(settingsPath, ['permissions', 'allow'], [RULE]);
    expect(existsSync(`${settingsPath}.wigolo-tmp`)).toBe(false);
  });

  it('replaces a non-array value at the leaf rather than crashing', () => {
    // Defensive: a hand-edited config could have the wrong shape here.
    writeSettings({ permissions: { allow: 'not-an-array' } });

    mergeJsonArray(settingsPath, ['permissions', 'allow'], [RULE]);

    expect(allowList()).toEqual([RULE]);
  });

  it('never touches the real home directory', () => {
    // Guard against a future refactor that resolves the path itself.
    expect(settingsPath.startsWith(tmpHome)).toBe(true);
    expect(settingsPath.startsWith(join(homedir(), '.claude'))).toBe(false);
  });
});
