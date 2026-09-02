import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TELEMETRY_OFF_VALUES,
  parseTelemetryEnv,
  resolveTelemetryEnabled,
} from '../../../src/telemetry/off-switch.js';
import { getConfig, resetConfig } from '../../../src/config.js';
import { resetPersistedConfig } from '../../../src/persisted-config.js';
import { migrateV1ToV2 } from '../../../src/cli/tui/schema/migrate.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_ENV = process.env;

describe('telemetry off switch', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.WIGOLO_TELEMETRY;
    resetConfig();
    resetPersistedConfig();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    resetConfig();
    resetPersistedConfig();
  });

  describe('parseTelemetryEnv', () => {
    it('treats every documented off spelling as off', () => {
      for (const value of ['0', 'false', 'off', 'no']) {
        expect(parseTelemetryEnv(value), value).toBe(false);
      }
    });

    it('accepts the off spellings trimmed and in any case', () => {
      for (const value of [' off ', 'OFF', 'No', '\tFALSE\n', ' 0']) {
        expect(parseTelemetryEnv(value), JSON.stringify(value)).toBe(false);
      }
    });

    it('treats any other set value as on', () => {
      for (const value of ['1', 'true', 'yes', 'on', 'nope', '']) {
        expect(parseTelemetryEnv(value), JSON.stringify(value)).toBe(true);
      }
    });

    it('returns undefined when unset, so the persisted layer can speak', () => {
      expect(parseTelemetryEnv(undefined)).toBeUndefined();
    });

    /**
     * The reason this parser exists at all, asserted rather than asserted-in-a-comment.
     * `envBool` (src/config.ts) returns `envVal.toLowerCase() !== 'false' && envVal !== '0'`,
     * so it recognises exactly two off spellings. Reproducing that expression here shows
     * `off` and `no` reaching it as ON — which is why widening `envBool` was rejected
     * (it would flip every existing knob set to `off`) and a dedicated parser shipped.
     */
    it('diverges from envBool exactly on the spellings envBool cannot express', () => {
      const envBoolWouldSay = (raw: string): boolean => raw.toLowerCase() !== 'false' && raw !== '0';
      expect(envBoolWouldSay('off')).toBe(true);
      expect(envBoolWouldSay('no')).toBe(true);
      expect(parseTelemetryEnv('off')).toBe(false);
      expect(parseTelemetryEnv('no')).toBe(false);
      // And they agree where envBool is already correct.
      for (const shared of ['0', 'false', '1', 'true']) {
        expect(parseTelemetryEnv(shared), shared).toBe(envBoolWouldSay(shared));
      }
    });

    it('publishes the off-value set the docs name', () => {
      expect([...TELEMETRY_OFF_VALUES].sort()).toEqual(['0', 'false', 'no', 'off']);
    });
  });

  describe('resolveTelemetryEnabled', () => {
    it('defaults on — 0.3.0 ships opt-out', () => {
      expect(resolveTelemetryEnabled(undefined, undefined)).toBe(true);
    });

    it('honours a persisted false with no env set', () => {
      expect(resolveTelemetryEnabled(undefined, false)).toBe(false);
    });

    it('lets env beat persisted in both directions', () => {
      expect(resolveTelemetryEnabled('off', true)).toBe(false);
      expect(resolveTelemetryEnabled('1', false)).toBe(true);
    });

    it('ignores a non-boolean persisted value rather than coercing it', () => {
      // A corrupt settings file must not be able to move the switch either way.
      for (const junk of ['false', 0, null, {}, []]) {
        expect(resolveTelemetryEnabled(undefined, junk), JSON.stringify(junk)).toBe(true);
      }
    });
  });

  describe('config.telemetryEnabled', () => {
    it('is on by default', () => {
      expect(getConfig().telemetryEnabled).toBe(true);
    });

    it('is off when WIGOLO_TELEMETRY=off', () => {
      process.env.WIGOLO_TELEMETRY = 'off';
      resetConfig();
      expect(getConfig().telemetryEnabled).toBe(false);
    });

    it('is off when WIGOLO_TELEMETRY=no', () => {
      process.env.WIGOLO_TELEMETRY = 'no';
      resetConfig();
      expect(getConfig().telemetryEnabled).toBe(false);
    });

    it('survives the v1 to v2 migration as a boolean, not as the string it was written as', () => {
      // A rename alone copies the value verbatim. A hand-written `WIGOLO_TELEMETRY: "0"`
      // would then arrive as the string '0', be ignored as a non-boolean, and fall through
      // to the 0.3.0 default — ON — silently reversing the one thing the user wrote down.
      expect(migrateV1ToV2({ version: 1, settings: { WIGOLO_TELEMETRY: '0' } }).settings).toMatchObject({
        telemetryEnabled: false,
      });
      for (const spelling of ['off', 'no', 'false', 'OFF ']) {
        expect(
          migrateV1ToV2({ version: 1, settings: { WIGOLO_TELEMETRY: spelling } }).settings['telemetryEnabled'],
          spelling,
        ).toBe(false);
      }
      expect(migrateV1ToV2({ version: 1, settings: { WIGOLO_TELEMETRY: '1' } }).settings['telemetryEnabled']).toBe(true);
      // Already flat and already boolean: carried straight through.
      expect(migrateV1ToV2({ version: 1, settings: { telemetryEnabled: false } }).settings['telemetryEnabled']).toBe(false);
      // Not preserved under __legacy with a warning, which is where an unknown key goes.
      expect(migrateV1ToV2({ version: 1, settings: { WIGOLO_TELEMETRY: 'off' } }).settings['__legacy']).toBeUndefined();
    });

    it('is off from the persisted settings key alone, with no env set', () => {
      const dir = mkdtempSync(join(tmpdir(), 'wigolo-telemetry-cfg-'));
      try {
        const configPath = join(dir, 'config.json');
        writeFileSync(configPath, JSON.stringify({ version: 1, settings: { telemetryEnabled: false } }));
        process.env.WIGOLO_CONFIG_PATH = configPath;
        delete process.env.WIGOLO_TELEMETRY;
        resetPersistedConfig();
        resetConfig();
        expect(getConfig().telemetryEnabled).toBe(false);

        // …and the env still wins over it, in the on direction too.
        process.env.WIGOLO_TELEMETRY = '1';
        resetConfig();
        expect(getConfig().telemetryEnabled).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
