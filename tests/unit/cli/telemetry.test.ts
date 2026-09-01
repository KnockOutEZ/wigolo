import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';

/**
 * `src/cli/telemetry.ts` has been ABSORBED into `src/telemetry/` (A-212-7).
 *
 * What it used to be — an opt-in day-file logger with an optional fire-and-forget POST to
 * `WIGOLO_TELEMETRY_ENDPOINT` — is gone, not re-homed. These tests pin the two things that
 * absorption has to mean: the old module holds no implementation of its own, and the retired
 * API is actually unreachable rather than quietly still working.
 */
const shim = await import('../../../src/cli/telemetry.js');
const owner = await import('../../../src/telemetry/index.js');

const ORIGINAL_ENV = process.env;
let dataDir: string;

describe('src/cli/telemetry.ts (deprecated shim)', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-telemetry-shim-'));
    process.env = { ...ORIGINAL_ENV };
    process.env.WIGOLO_DATA_DIR = dataDir;
    delete process.env.WIGOLO_TELEMETRY;
    delete process.env.WIGOLO_TELEMETRY_ENDPOINT;
    resetConfig();
    owner._resetTelemetryForTest();
  });

  afterEach(() => {
    owner._resetTelemetryForTest();
    process.env = ORIGINAL_ENV;
    resetConfig();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('re-exports the one implementation rather than keeping a copy', () => {
    // Object identity, not behavioural equivalence: a second implementation that merely
    // agreed today is exactly what "absorbed, not duplicated" forbids.
    expect(shim.isTelemetryEnabled).toBe(owner.isTelemetryEnabled);
    expect(shim.telemetryStatus).toBe(owner.telemetryStatus);
  });

  it('no longer exposes the retired free-POST API', () => {
    const exported = Object.keys(shim).sort();
    expect(exported).toEqual(['isTelemetryEnabled', 'telemetryStatus']);
    for (const gone of ['emit', 'configureRemote', '_resetTelemetryForTest']) {
      expect(exported).not.toContain(gone);
    }
  });

  it('answers the activation-aware question, not the old env comparison', () => {
    // The old predicate was `process.env.WIGOLO_TELEMETRY === '1'`. Under it this would be
    // true; under the shipped one an un-activated install collects nothing whatever the
    // switch says.
    process.env.WIGOLO_TELEMETRY = '1';
    resetConfig();
    owner._resetTelemetryForTest();
    expect(process.env.WIGOLO_TELEMETRY === '1').toBe(true);
    expect(shim.isTelemetryEnabled()).toBe(false);
    expect(shim.telemetryStatus()).toBe('not_activated');
  });

  it('writes no day-file — the rotation the old module owned is gone', () => {
    process.env.WIGOLO_TELEMETRY = '1';
    resetConfig();
    owner._resetTelemetryForTest();
    shim.isTelemetryEnabled();
    const dir = join(dataDir, 'telemetry');
    const files = existsSync(dir) ? readdirSync(dir) : [];
    expect(files.filter((f) => /^events-\d{8}\.ndjson$/.test(f))).toEqual([]);
  });
});
