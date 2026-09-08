import { describe, it, expect } from 'vitest';
import { CATALOG } from '../../../../../src/cli/tui/schema/catalog.js';
import { field } from '../../../../../src/cli/tui/schema/from-registry.js';
import {
  CONFIG_KEYS,
  configKeyBySettingsKey,
  configKeyIdentifier,
} from '../../../../../src/config.js';

const FIELDS = CATALOG.flatMap((c) => c.fields);

describe('CATALOG', () => {
  it('declares unique category ids', () => {
    const ids = CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every field key in every category is unique across the catalog', () => {
    const keys = FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists six categories in the spec home-layout order', () => {
    expect(CATALOG.map((c) => c.id)).toEqual([
      'browser',
      'search',
      'llm',
      'agents',
      'cache',
      'advanced',
    ]);
  });
});

/**
 * The catalog is one projection of `CONFIG_KEYS`; `--set`, the agent env block
 * and (once built) the control portal are the others. These arms enumerate
 * every field rather than sampling, because the shipped catalog was correct
 * for eighteen keys and wrong for six — a sample would have passed.
 */
describe('CATALOG is a projection of CONFIG_KEYS', () => {
  it('sources every field from a registered key', () => {
    for (const f of FIELDS) {
      expect(
        configKeyBySettingsKey(f.settingsPath),
        `${f.settingsPath} is not in CONFIG_KEYS`,
      ).toBeDefined();
    }
  });

  it('restates no identifier, default or env var of its own', () => {
    const drift: string[] = [];
    for (const f of FIELDS) {
      const def = configKeyBySettingsKey(f.settingsPath)!;
      if (f.key !== configKeyIdentifier(def)) {
        drift.push(`${f.settingsPath}: prints ${f.key}, registry says ${configKeyIdentifier(def)}`);
      }
      if (f.envVar !== def.envVar) {
        drift.push(`${f.settingsPath}: envVar ${String(f.envVar)} vs ${String(def.envVar)}`);
      }
      // Two exceptions, both about what the EDITOR would persist: a masked
      // field must carry no default or the placeholder becomes a printable
      // value, and a sentinel default must not be pre-fillable.
      const expectedDefault =
        f.kind === 'masked' || def.sentinelDefault === true ? undefined : def.default;
      if (JSON.stringify(f.default) !== JSON.stringify(expectedDefault)) {
        drift.push(
          `${f.settingsPath}: default ${JSON.stringify(f.default)} vs ${JSON.stringify(expectedDefault)}`,
        );
      }
    }
    expect(drift).toEqual([]);
  });

  it('never offers a picker value the registry does not allow', () => {
    for (const f of FIELDS) {
      const def = configKeyBySettingsKey(f.settingsPath)!;
      if (!f.options || !def.enumValues) continue;
      for (const opt of f.options) {
        expect(def.enumValues, `${f.settingsPath} offers ${opt.value}`).toContain(opt.value);
      }
    }
  });

  it('never propagates a key no env var resolves', () => {
    for (const f of FIELDS) {
      const def = configKeyBySettingsKey(f.settingsPath)!;
      if (def.envVar !== null) continue;
      expect(f.propagateToAgents, `${f.settingsPath} has no env var but propagates`).toBe(false);
    }
  });

  it('refuses a field whose key was never registered', () => {
    // The guard that makes the projection enforceable rather than advisory:
    // the catalog is built at import time, so an unregistered key fails the
    // process instead of printing a setting nothing reads.
    expect(() => field('notARegisteredKey', { label: 'Nope' })).toThrow(/not in CONFIG_KEYS/);
  });

  it('refuses a picker offering a value outside the registered set', () => {
    expect(() =>
      field('logLevel', {
        label: 'Log level',
        kind: 'select',
        options: [{ value: 'trace', label: 'trace' }],
      }),
    ).toThrow(/outside its registered values/);
  });

  it('leaves every unsurfaced registry key available to the next projection', () => {
    // Not a completeness claim: the registry may hold keys the CLI does not
    // display. It must never hold FEWER than the CLI displays.
    const surfaced = new Set(FIELDS.map((f) => f.settingsPath));
    const registered = new Set(CONFIG_KEYS.map((d) => d.settingsKey));
    for (const key of surfaced) expect(registered.has(key)).toBe(true);
  });
});
