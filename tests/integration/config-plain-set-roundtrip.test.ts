/**
 * End-to-end proof for K12 + K13 against the real `wigolo config` command —
 * no mocks of the resolver, the catalog or the persisted-config layer.
 *
 * The unit arms assert the registry agrees with the resolver. These assert the
 * three user-visible consequences of that agreement, because a correct
 * registry that the command does not actually read would pass every unit arm:
 *
 *  1. every identifier `--plain` prints is one `--set` accepts;
 *  2. every default `--plain` prints is one `getConfig()` resolves;
 *  3. `--cache-stats` succeeds and exits 0 on a data directory the process
 *     has not opened — the shipped command exited 1 with "Database not
 *     initialized" while `wigolo cache --stats` succeeded on the same data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../../src/cli/config.js';
import { CATALOG } from '../../src/cli/tui/schema/catalog.js';
import { getConfig, resetConfig, configKeyBySettingsKey } from '../../src/config.js';
import { closeDatabase } from '../../src/cache/db.js';

let home: string;
let dataDir: string;
let configPath: string;
let savedEnv: Record<string, string | undefined>;
let stdout: string[];
let stderr: string[];
let writeOut: typeof process.stdout.write;
let writeErr: typeof process.stderr.write;

/** Every env var that could shadow a printed default or redirect a layer. */
function managedEnv(): string[] {
  const names = new Set<string>([
    'HOME',
    'WIGOLO_CONFIG_PATH',
    'WIGOLO_DATA_DIR',
    'WIGOLO_HARDCORE',
    'CI',
    'GITHUB_ACTIONS',
  ]);
  for (const category of CATALOG) {
    for (const f of category.fields) {
      if (f.envVar) names.add(f.envVar);
      for (const legacy of f.legacyKeys ?? []) names.add(legacy);
    }
  }
  return [...names];
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sd34-e2e-'));
  dataDir = join(home, '.wigolo');
  configPath = join(dataDir, 'config.json');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ version: 1, settings: {} }), 'utf8');

  savedEnv = {};
  for (const name of managedEnv()) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  // HOME is redirected so `--set`'s agent detection finds no real editor
  // config to write into.
  process.env.HOME = home;
  process.env.WIGOLO_CONFIG_PATH = configPath;
  process.env.WIGOLO_DATA_DIR = dataDir;
  resetConfig();

  stdout = [];
  stderr = [];
  writeOut = process.stdout.write.bind(process.stdout);
  writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = writeOut;
  process.stderr.write = writeErr;
  closeDatabase();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

/** The `IDENTIFIER   value` rows of a `--plain` printout. */
function parsePlainRows(out: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^ {2}(\S+)\s{2,}(.*)$/.exec(line);
    // The trailing "Headless commands:" block is two-space indented too, but
    // its first token is always the `wigolo` binary.
    if (m && m[1] !== 'wigolo') rows.set(m[1], m[2]!.trim());
  }
  return rows;
}

describe('wigolo config --plain enumerates keys --set accepts', () => {
  it('prints one row per catalog field and nothing else', async () => {
    expect(await runConfig(['--plain'])).toBe(0);
    const rows = parsePlainRows(stdout.join(''));
    const expected = CATALOG.flatMap((c) => c.fields.map((f) => f.key)).sort();
    expect([...rows.keys()].sort()).toEqual(expected);
  });

  it('accepts every printed identifier as a --set key', async () => {
    expect(await runConfig(['--plain'])).toBe(0);
    const printed = [...parsePlainRows(stdout.join('')).keys()];
    expect(printed.length).toBeGreaterThan(0);

    const { applyHeadlessSet } = await import('../../src/cli/tui/actions/index.js');
    const rejected: string[] = [];
    for (const key of printed) {
      const result = await applyHeadlessSet({
        key,
        value: 'x',
        configPath,
        catalog: CATALOG,
        agents: [],
        secretStore: {
          set: async () => ({ location: 'memory' as const }),
          remove: async () => {},
        },
        // Resolve-only: a validation or secret refusal still proves the key is
        // known, and nothing is written.
        save: async () => ({ saved: [], propagated: [], failed: [] }),
      });
      if (result.status === 'unknown_key') rejected.push(key);
    }
    expect(rejected, 'printed keys that --set does not accept').toEqual([]);
  });

  it('still accepts every identifier an older build printed', async () => {
    const { applyHeadlessSet } = await import('../../src/cli/tui/actions/index.js');
    const legacy = CATALOG.flatMap((c) => c.fields).flatMap((f) => f.legacyKeys ?? []);
    // The shipped build documented six of these as the --set keys; dropping
    // them would break a working invocation.
    expect(legacy.length).toBeGreaterThan(0);
    for (const key of legacy) {
      const result = await applyHeadlessSet({
        key,
        value: 'x',
        configPath,
        catalog: CATALOG,
        agents: [],
        secretStore: {
          set: async () => ({ location: 'memory' as const }),
          remove: async () => {},
        },
        save: async () => ({ saved: [], propagated: [], failed: [] }),
      });
      expect(result.status, `legacy key ${key} rejected`).not.toBe('unknown_key');
    }
  });
});

describe('wigolo config --plain shows the defaults the resolver resolves', () => {
  it('diffs empty against getConfig() for every key with a resolved default', async () => {
    expect(await runConfig(['--plain'])).toBe(0);
    const rows = parsePlainRows(stdout.join(''));
    const resolved = getConfig() as unknown as Record<string, unknown>;

    const diffs: string[] = [];
    for (const category of CATALOG) {
      for (const f of category.fields) {
        const def = configKeyBySettingsKey(f.settingsPath)!;
        // A secret prints a presence flag, and dataDir's row is the built-in
        // default while the test redirects it — both are display contracts,
        // not resolver values.
        if (def.secret === true || f.settingsPath === 'dataDir') continue;
        if (!def.resolved) continue;

        const printed = rows.get(f.key);
        const actual = resolved[f.settingsPath];
        const shown =
          actual === null || actual === undefined
            ? null
            : Array.isArray(actual)
              ? actual.join(', ')
              : String(actual);

        if (shown === null) {
          // An unset key prints "(unset…)", never a stringified null.
          if (!/^\(unset/.test(printed ?? '')) {
            diffs.push(`${f.key}: printed ${printed}, resolver has no value`);
          }
          continue;
        }
        if (!(printed ?? '').startsWith(shown)) {
          diffs.push(`${f.key}: printed ${printed}, resolver resolves ${shown}`);
        }
      }
    }
    expect(diffs, 'rows whose default contradicts the resolver').toEqual([]);
  });

  it('round-trips a previously-wrong key through --set into the resolver', async () => {
    // reranker is the sharpest of the seven: the shipped catalog made it a
    // boolean toggle, and the resolver drops a non-string persisted value, so
    // turning it "off" left the reranker on.
    writeFileSync(
      configPath,
      JSON.stringify({ version: 1, settings: { reranker: false } }),
      'utf8',
    );
    resetConfig();
    expect(getConfig().reranker).toBe('onnx');

    expect(await runConfig(['--set', 'WIGOLO_RERANKER=none'])).toBe(0);
    resetConfig();
    expect(getConfig().reranker).toBe('none');
    expect(JSON.parse(readFileSync(configPath, 'utf8')).settings.reranker).toBe('none');
  });

  it('writes the setting when --set is given the legacy identifier', async () => {
    expect(await runConfig(['--set', 'WIGOLO_CACHE_TTL_SEARCH=7200'])).toBe(0);
    resetConfig();
    expect(getConfig().cacheTtlSearch).toBe(7200);
  });
});

describe('wigolo config --cache-stats (K13)', () => {
  it('succeeds and exits 0 on a data directory nothing has opened', async () => {
    const code = await runConfig(['--cache-stats']);
    const out = stdout.join('');
    expect(stderr.join('')).not.toMatch(/Database not initialized/);
    expect(code).toBe(0);
    expect(out).toMatch(/Cache statistics/);
    expect(out).toMatch(/Entries:\s+\d+/);
  });

  it('exits 0 again on a second invocation', async () => {
    // The reported symptom included an exit code that differed between
    // invocations. Both are 0 now, and the second reuses the open database.
    expect(await runConfig(['--cache-stats'])).toBe(0);
    stdout.length = 0;
    expect(await runConfig(['--cache-stats'])).toBe(0);
    expect(stdout.join('')).toMatch(/Cache statistics/);
  });
});
