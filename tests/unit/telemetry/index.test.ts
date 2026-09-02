import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/security/keychain.js', () => {
  const store = new Map<string, string>();
  return {
    keychainAvailable: vi.fn(() => true),
    keychainSet: vi.fn((service: string, user: string, value: string) => { store.set(`${service}:${user}`, value); }),
    keychainGet: vi.fn((service: string, user: string) => store.get(`${service}:${user}`) ?? null),
    keychainDelete: vi.fn((service: string, user: string) => { store.delete(`${service}:${user}`); }),
  };
});

const { resetConfig } = await import('../../../src/config.js');
const { AccountStateStore } = await import('../../../src/account/state.js');
const { queuePath } = await import('../../../src/telemetry/queue.js');
const telemetry = await import('../../../src/telemetry/index.js');

const ORIGINAL_ENV = process.env;
let dataDir: string;
let stderr: string[];

function captureStderr(): void {
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
}

function activate(): void {
  new AccountStateStore(dataDir).write({ account_id: 'acc_index' });
}

describe('telemetry module surface', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-telemetry-index-'));
    process.env = { ...ORIGINAL_ENV };
    process.env.WIGOLO_DATA_DIR = dataDir;
    delete process.env.WIGOLO_TELEMETRY;
    delete process.env.WIGOLO_TELEMETRY_ENDPOINT;
    resetConfig();
    telemetry._resetTelemetryForTest();
  });

  afterEach(() => {
    telemetry._resetTelemetryForTest();
    process.env = ORIGINAL_ENV;
    resetConfig();
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('telemetryStatus', () => {
    it('is not_activated on a fresh install, even with the switch on', () => {
      expect(telemetry.telemetryStatus()).toBe('not_activated');
      expect(telemetry.isTelemetryEnabled()).toBe(false);
    });

    it('is enabled once an account exists', () => {
      activate();
      expect(telemetry.telemetryStatus()).toBe('enabled');
      expect(telemetry.isTelemetryEnabled()).toBe(true);
    });

    it('is disabled by the env switch regardless of activation', () => {
      activate();
      process.env.WIGOLO_TELEMETRY = 'off';
      resetConfig();
      telemetry._resetTelemetryForTest();
      expect(telemetry.telemetryStatus()).toBe('disabled');
      expect(telemetry.isTelemetryEnabled()).toBe(false);
    });

    it('distinguishes the two ways telemetry can be off', () => {
      // doctor prints a different line for each; collapsing them would tell a registered
      // user who opted out that they need to register.
      expect(telemetry.telemetryStatus()).toBe('not_activated');
      activate();
      process.env.WIGOLO_TELEMETRY = '0';
      resetConfig();
      telemetry._resetTelemetryForTest();
      expect(telemetry.telemetryStatus()).toBe('disabled');
    });
  });

  describe('emit through the singleton', () => {
    it('queues when on and activated', () => {
      activate();
      expect(telemetry.emit({ name: 'daemon.uptime', props: { bucket: 'lt_1h' } })).toBe(true);
      expect(existsSync(queuePath(dataDir))).toBe(true);
    });

    it('writes nothing at all when off', () => {
      activate();
      process.env.WIGOLO_TELEMETRY = 'off';
      resetConfig();
      telemetry._resetTelemetryForTest();
      expect(telemetry.emit({ name: 'daemon.uptime', props: { bucket: 'lt_1h' } })).toBe(false);
      expect(existsSync(queuePath(dataDir))).toBe(false);
    });

    it('is disabled by flush too when off', async () => {
      process.env.WIGOLO_TELEMETRY = 'no';
      resetConfig();
      telemetry._resetTelemetryForTest();
      await expect(telemetry.flushTelemetry()).resolves.toMatchObject({ status: 'disabled' });
    });
  });

  describe('WIGOLO_TELEMETRY_ENDPOINT deprecation', () => {
    it('warns once when the retired variable is set, and changes nothing', () => {
      process.env.WIGOLO_TELEMETRY_ENDPOINT = 'https://collector.example.com/ingest';
      resetConfig();
      telemetry._resetTelemetryForTest();
      captureStderr();

      telemetry.warnDeprecatedEndpointEnv();
      telemetry.warnDeprecatedEndpointEnv();
      telemetry.warnDeprecatedEndpointEnv();

      const warnings = stderr.filter((line) => line.includes('WIGOLO_TELEMETRY_ENDPOINT'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/deprecated and ignored/);
    });

    it('says nothing when the variable is unset', () => {
      captureStderr();
      telemetry.warnDeprecatedEndpointEnv();
      expect(stderr.filter((l) => l.includes('WIGOLO_TELEMETRY_ENDPOINT'))).toEqual([]);
    });

    it('never sends anywhere but the account service', async () => {
      // The old behaviour was a fire-and-forget POST to whatever this named. If the
      // variable were still honoured, an unstubbed fetch to this host would trip the
      // suite's network fence — which is exactly the regression this pins.
      activate();
      process.env.WIGOLO_TELEMETRY_ENDPOINT = 'https://collector.example.com/ingest';
      resetConfig();
      telemetry._resetTelemetryForTest();
      telemetry.emit({ name: 'daemon.uptime', props: { bucket: 'lt_1h' } });
      const result = await telemetry.flushTelemetry();
      // No credential on a fresh data dir, so nothing leaves — and nothing tried to.
      expect(result.status).toBe('no_token');
    });
  });

  it('re-reads config after a reset rather than freezing the first answer', () => {
    activate();
    expect(telemetry.isTelemetryEnabled()).toBe(true);
    process.env.WIGOLO_TELEMETRY = 'false';
    resetConfig();
    telemetry._resetTelemetryForTest();
    expect(telemetry.isTelemetryEnabled()).toBe(false);
  });
});
