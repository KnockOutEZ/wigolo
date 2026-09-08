/**
 * The registry is only worth having if it cannot drift from the resolver, and
 * the shipped catalog proved that restating an env-var name or a default by
 * hand drifts silently: six of the names `wigolo config --plain` printed were
 * read by nothing, and nine of its defaults contradicted `getConfig()`.
 *
 * So every arm below enumerates `CONFIG_KEYS` and probes the REAL resolver per
 * entry. Sampling the known-wrong keys would have passed against the shipped
 * catalog for the other eighteen.
 *
 * The probe map is deliberately exhaustive rather than derived: a new registry
 * entry with no probe fails `every env-backed key has a probe value`, so the
 * next key cannot be added without an env-name proof.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_KEYS,
  configKeyByIdentifier,
  configKeyBySettingsKey,
  configKeyIdentifier,
  getConfig,
  resetConfig,
  type ConfigKeyDef,
} from '../../../src/config.js';

/**
 * A value per env-backed key that is NOT the key's default, so a resolver that
 * ignored the env var shows up as "value unchanged" rather than passing.
 * Values have to be ones the resolver accepts — `newTabSearchEngine` is
 * validated on read, so a garbage probe would throw instead of proving
 * anything.
 */
const ENV_PROBES: Record<string, { raw: string; expect: unknown }> = {
  browserTypes: { raw: 'firefox', expect: ['firefox'] },
  maxBrowsers: { raw: '9', expect: 9 },
  browserIdleTimeoutMs: { raw: '12345', expect: 12345 },
  searchBackend: { raw: 'hybrid', expect: 'hybrid' },
  newTabSearchEngine: { raw: 'duckduckgo', expect: 'duckduckgo' },
  reranker: { raw: 'none', expect: 'none' },
  rerankerModel: { raw: 'sd34-probe-model', expect: 'sd34-probe-model' },
  embeddingModel: { raw: 'sd34/probe-embed', expect: 'sd34/probe-embed' },
  llmProvider: { raw: 'gemini', expect: 'gemini' },
  dataDir: { raw: '/tmp/sd34-probe-data-dir', expect: '/tmp/sd34-probe-data-dir' },
  cacheTtlSearch: { raw: '4242', expect: 4242 },
  cacheTtlContent: { raw: '424242', expect: 424242 },
  logLevel: { raw: 'warn', expect: 'warn' },
  proxyUrl: { raw: 'http://proxy.sd34.invalid:8080', expect: 'http://proxy.sd34.invalid:8080' },
  useProxy: { raw: 'true', expect: true },
  solverUrl: { raw: 'https://solver.sd34.invalid', expect: 'https://solver.sd34.invalid' },
  hostedReaderUrl: { raw: 'https://reader.sd34.invalid', expect: 'https://reader.sd34.invalid' },
  userAgent: { raw: 'sd34-probe-agent', expect: 'sd34-probe-agent' },
  daemonPort: { raw: '4111', expect: 4111 },
  accountsUrl: { raw: 'https://accounts.sd34.invalid', expect: 'https://accounts.sd34.invalid' },
  telemetryEnabled: { raw: 'off', expect: false },
  daemonHost: { raw: '0.0.0.0', expect: '0.0.0.0' },
};

/** Keys the resolver exposes and that an env var feeds. */
function envBackedResolvedKeys(): ConfigKeyDef[] {
  return CONFIG_KEYS.filter((d) => d.resolved && d.envVar !== null);
}

/**
 * Every env var any registry entry names, plus the ones that redirect the
 * resolver's own layers. Cleared per test so an ambient value in the runner's
 * environment can never make a default assertion trivially true.
 */
function allRegistryEnvVars(): string[] {
  const names = new Set<string>(['WIGOLO_CONFIG_PATH', 'WIGOLO_HARDCORE']);
  for (const def of CONFIG_KEYS) {
    if (def.envVar !== null) names.add(def.envVar);
    for (const legacy of def.legacyKeys ?? []) names.add(legacy);
  }
  return [...names];
}

let tmpDir: string;
let configPath: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sd34-registry-'));
  configPath = join(tmpDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ settings: {} }), 'utf8');

  savedEnv = {};
  for (const name of allRegistryEnvVars()) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.WIGOLO_CONFIG_PATH = configPath;
  resetConfig();
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetConfig();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('CONFIG_KEYS registry', () => {
  it('declares a unique settings key per entry', () => {
    const keys = CONFIG_KEYS.map((d) => d.settingsKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never reuses one identifier across two entries', () => {
    const seen = new Map<string, string>();
    for (const def of CONFIG_KEYS) {
      for (const id of [def.envVar, def.settingsKey, ...(def.legacyKeys ?? [])]) {
        if (id === null) continue;
        const owner = seen.get(id);
        expect(owner, `identifier ${id} claimed by both ${owner} and ${def.settingsKey}`)
          .toBeUndefined();
        seen.set(id, def.settingsKey);
      }
    }
  });

  it('resolves every identifier — env var, settings key and legacy name — back to its entry', () => {
    for (const def of CONFIG_KEYS) {
      expect(configKeyBySettingsKey(def.settingsKey)).toBe(def);
      if (def.envVar !== null) expect(configKeyByIdentifier(def.envVar)).toBe(def);
      for (const legacy of def.legacyKeys ?? []) {
        expect(configKeyByIdentifier(legacy), `legacy ${legacy} unroutable`).toBe(def);
      }
    }
  });

  it('prints the env var when one resolves the key, the settings key when none does', () => {
    for (const def of CONFIG_KEYS) {
      const printed = configKeyIdentifier(def);
      if (def.envVar === null) expect(printed).toBe(def.settingsKey);
      else expect(printed).toBe(def.envVar);
      // A legacy name is accepted, never advertised: it is not an env var
      // anything reads, which is the whole reason it is legacy.
      expect(def.legacyKeys ?? []).not.toContain(printed);
    }
  });

  it('never advertises a legacy name as an env var', () => {
    const advertised = new Set(
      CONFIG_KEYS.map((d) => d.envVar).filter((v): v is string => v !== null),
    );
    for (const def of CONFIG_KEYS) {
      for (const legacy of def.legacyKeys ?? []) {
        expect(advertised.has(legacy), `${legacy} is both legacy and advertised`).toBe(false);
      }
    }
  });

  it('every env-backed key has a probe value', () => {
    const missing = envBackedResolvedKeys()
      .map((d) => d.settingsKey)
      .filter((k) => ENV_PROBES[k] === undefined);
    expect(missing, 'add an ENV_PROBES entry so the env-var name is proved').toEqual([]);
  });

  it("declares each resolved key's default as the value getConfig() actually resolves", () => {
    const resolved = getConfig() as unknown as Record<string, unknown>;
    const mismatches: string[] = [];
    for (const def of CONFIG_KEYS) {
      if (!def.resolved) continue;
      const actual = resolved[def.settingsKey];
      try {
        expect(actual).toEqual(def.default);
      } catch {
        mismatches.push(
          `${def.settingsKey}: registry ${JSON.stringify(def.default)} vs resolver ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('exposes no resolved value for a key it marks unresolved', () => {
    const resolved = getConfig() as unknown as Record<string, unknown>;
    for (const def of CONFIG_KEYS) {
      if (def.resolved) continue;
      expect(resolved[def.settingsKey], `${def.settingsKey} is resolved after all`).toBeUndefined();
    }
  });

  it('names an env var the resolver actually reads, for every env-backed key', () => {
    const failures: string[] = [];
    for (const def of envBackedResolvedKeys()) {
      const probe = ENV_PROBES[def.settingsKey];
      if (!probe) continue;
      // Force the override, then assert it took: an env name nothing reads
      // leaves the default in place, which is exactly the shipped defect.
      process.env[def.envVar as string] = probe.raw;
      resetConfig();
      const actual = (getConfig() as unknown as Record<string, unknown>)[def.settingsKey];
      delete process.env[def.envVar as string];
      resetConfig();
      try {
        expect(actual).toEqual(probe.expect);
      } catch {
        failures.push(
          `${def.envVar} → ${def.settingsKey}: expected ${JSON.stringify(probe.expect)}, resolver gave ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('leaves the default in place when a legacy name is exported instead', () => {
    // The reason legacy names stay accepted by --set but never printed: the
    // resolver does not read them. If one of these ever starts working, it is
    // a real env var and belongs in `envVar`.
    const leaked: string[] = [];
    for (const def of CONFIG_KEYS) {
      for (const legacy of def.legacyKeys ?? []) {
        const probe = ENV_PROBES[def.settingsKey];
        if (!probe) continue;
        process.env[legacy] = probe.raw;
        resetConfig();
        const actual = (getConfig() as unknown as Record<string, unknown>)[def.settingsKey];
        delete process.env[legacy];
        resetConfig();
        if (def.resolved && JSON.stringify(actual) !== JSON.stringify(def.default)) {
          leaked.push(`${legacy} changed ${def.settingsKey} to ${JSON.stringify(actual)}`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it('constrains an enum key to values the resolver tolerates', () => {
    for (const def of CONFIG_KEYS) {
      if (!def.enumValues) continue;
      expect(def.enumValues.length, `${def.settingsKey} enum is empty`).toBeGreaterThan(0);
      expect(new Set(def.enumValues).size).toBe(def.enumValues.length);
      if (typeof def.default === 'string') {
        expect(def.enumValues, `${def.settingsKey} default not in its own enum`)
          .toContain(def.default);
      }
    }
  });
});
