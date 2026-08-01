import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, resetConfig } from '../../../src/config.js';
import {
  resetPersistedConfig,
  _setCredentialKeychainForTests,
  SETTINGS_SECRETS_DENYLIST,
} from '../../../src/persisted-config.js';

const HARDCORE_ENV_KEYS = [
  'WIGOLO_HARDCORE',
  'WIGOLO_AUTO_PASS',
  'WIGOLO_CDP_DIRECT',
  'WIGOLO_AI_SOLVE',
  'WIGOLO_AI_SOLVE_MAX_ATTEMPTS',
  'WIGOLO_HUMAN_SOLVE',
  'WIGOLO_HUMAN_SOLVE_MS',
  'WIGOLO_HUMAN_SOLVE_CONSENT',
  'WIGOLO_SCRAPING_BROWSER_WSS',
  'WIGOLO_STEALTH',
  'WIGOLO_STEALTH_DRIVER',
  'WIGOLO_BROWSER_CHANNEL',
  'WIGOLO_BROWSER_HEADFUL',
  'WIGOLO_HUMANIZE',
  'WIGOLO_CHALLENGE_COMPLETION_MS',
  'WIGOLO_PROXY_BYPASS_ON_CHALLENGE',
] as const;

const originalEnv = process.env;
let dir: string;
let store: Map<string, string>;

beforeEach(() => {
  process.env = { ...originalEnv };
  dir = mkdtempSync(join(tmpdir(), 'wigolo-hardcore-'));
  process.env.WIGOLO_CONFIG_PATH = join(dir, 'config.json');
  for (const k of HARDCORE_ENV_KEYS) delete process.env[k];
  store = new Map();
  _setCredentialKeychainForTests({
    available: () => true,
    set: (u, v) => void store.set(u, v),
    get: (u) => store.get(u) ?? null,
    del: (u) => void store.delete(u),
  });
  resetPersistedConfig();
  resetConfig();
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(dir, { recursive: true, force: true });
  _setCredentialKeychainForTests(null);
  resetPersistedConfig();
  resetConfig();
});

describe('config — hardcore-mode knob defaults', () => {
  it('all new knobs take their documented defaults when unset', () => {
    const cfg = getConfig();
    expect(cfg.hardcore).toBe('off');
    expect(cfg.autoPass).toBe('off');
    expect(cfg.cdpDirect).toBe('off');
    expect(cfg.aiSolve).toBe('off');
    expect(cfg.aiSolveMaxAttempts).toBe(2);
    expect(cfg.humanSolve).toBe('off');
    expect(cfg.humanSolveTimeoutMs).toBe(120000);
    expect(cfg.humanSolveConsent).toBe(false);
    expect(cfg.scrapingBrowserWss).toBeNull();
  });
});

describe('config — hardcore knob env / persisted / normalize', () => {
  it('WIGOLO_HARDCORE reads on/off and normalizes junk to off', () => {
    process.env.WIGOLO_HARDCORE = 'on';
    resetConfig();
    expect(getConfig().hardcore).toBe('on');

    process.env.WIGOLO_HARDCORE = 'weird';
    resetConfig();
    expect(getConfig().hardcore).toBe('off');
  });

  it('WIGOLO_HARDCORE reads from persisted settings', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { hardcore: 'on' } }),
    );
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().hardcore).toBe('on');
  });

  it('WIGOLO_AUTO_PASS: env off/auto/on, persisted, junk→off', () => {
    process.env.WIGOLO_AUTO_PASS = 'on';
    resetConfig();
    expect(getConfig().autoPass).toBe('on');

    process.env.WIGOLO_AUTO_PASS = 'off';
    resetConfig();
    expect(getConfig().autoPass).toBe('off');

    process.env.WIGOLO_AUTO_PASS = 'nonsense';
    resetConfig();
    expect(getConfig().autoPass).toBe('off');

    delete process.env.WIGOLO_AUTO_PASS;
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { autoPass: 'off' } }),
    );
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().autoPass).toBe('off');
  });

  it('WIGOLO_CDP_DIRECT: env, persisted, junk→off', () => {
    process.env.WIGOLO_CDP_DIRECT = 'auto';
    resetConfig();
    expect(getConfig().cdpDirect).toBe('auto');

    process.env.WIGOLO_CDP_DIRECT = 'zzz';
    resetConfig();
    expect(getConfig().cdpDirect).toBe('off');

    delete process.env.WIGOLO_CDP_DIRECT;
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { cdpDirect: 'on' } }),
    );
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().cdpDirect).toBe('on');
  });

  it('WIGOLO_AI_SOLVE: env, persisted, junk→off', () => {
    process.env.WIGOLO_AI_SOLVE = 'on';
    resetConfig();
    expect(getConfig().aiSolve).toBe('on');

    process.env.WIGOLO_AI_SOLVE = 'maybe';
    resetConfig();
    expect(getConfig().aiSolve).toBe('off');

    delete process.env.WIGOLO_AI_SOLVE;
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { aiSolve: 'auto' } }),
    );
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().aiSolve).toBe('auto');
  });

  it('WIGOLO_AI_SOLVE_MAX_ATTEMPTS: env, persisted, clamp >=1', () => {
    process.env.WIGOLO_AI_SOLVE_MAX_ATTEMPTS = '5';
    resetConfig();
    expect(getConfig().aiSolveMaxAttempts).toBe(5);

    process.env.WIGOLO_AI_SOLVE_MAX_ATTEMPTS = '0';
    resetConfig();
    expect(getConfig().aiSolveMaxAttempts).toBe(1);

    process.env.WIGOLO_AI_SOLVE_MAX_ATTEMPTS = '-3';
    resetConfig();
    expect(getConfig().aiSolveMaxAttempts).toBe(1);

    delete process.env.WIGOLO_AI_SOLVE_MAX_ATTEMPTS;
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { aiSolveMaxAttempts: 3 } }),
    );
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().aiSolveMaxAttempts).toBe(3);
  });

  it('WIGOLO_HUMAN_SOLVE: env, persisted, junk→off', () => {
    process.env.WIGOLO_HUMAN_SOLVE = 'auto';
    resetConfig();
    expect(getConfig().humanSolve).toBe('auto');

    process.env.WIGOLO_HUMAN_SOLVE = 'huh';
    resetConfig();
    expect(getConfig().humanSolve).toBe('off');

    delete process.env.WIGOLO_HUMAN_SOLVE;
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { humanSolve: 'on' } }),
    );
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().humanSolve).toBe('on');
  });

  it('WIGOLO_HUMAN_SOLVE_MS: env, persisted', () => {
    process.env.WIGOLO_HUMAN_SOLVE_MS = '90000';
    resetConfig();
    expect(getConfig().humanSolveTimeoutMs).toBe(90000);

    delete process.env.WIGOLO_HUMAN_SOLVE_MS;
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { humanSolveTimeoutMs: 60000 } }),
    );
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().humanSolveTimeoutMs).toBe(60000);
  });

  it('WIGOLO_HUMAN_SOLVE_CONSENT: env, persisted, default false', () => {
    process.env.WIGOLO_HUMAN_SOLVE_CONSENT = 'true';
    resetConfig();
    expect(getConfig().humanSolveConsent).toBe(true);

    delete process.env.WIGOLO_HUMAN_SOLVE_CONSENT;
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { humanSolveConsent: true } }),
    );
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().humanSolveConsent).toBe(true);
  });
});

describe('config — scrapingBrowserWss credential URL', () => {
  it('reads WIGOLO_SCRAPING_BROWSER_WSS verbatim from env (with inline creds)', () => {
    process.env.WIGOLO_SCRAPING_BROWSER_WSS = 'wss://user:pass@brd.example.com:9222';
    resetConfig();
    expect(getConfig().scrapingBrowserWss).toBe('wss://user:pass@brd.example.com:9222');
  });

  it('recomposes credential-free config.json host with keychain userinfo', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { scrapingBrowserWss: 'wss://brd.example.com:9222/' } }),
    );
    store.set('scrapingBrowserWss-cred', 'brduser:brdpass');
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().scrapingBrowserWss).toBe('wss://brduser:brdpass@brd.example.com:9222/');
  });

  it('is present in the persisted-config secrets denylist', () => {
    expect(SETTINGS_SECRETS_DENYLIST.has('scrapingBrowserWss')).toBe(true);
  });
});

describe('config — hardcore preset resolver', () => {
  it('hardcore=on flips every preset knob to its preset value when unset', () => {
    process.env.WIGOLO_HARDCORE = 'on';
    resetConfig();
    const cfg = getConfig();
    expect(cfg.stealth).toBe('on');
    expect(cfg.browserChannel).toBe('chrome');
    expect(cfg.browserHeadful).toBe(true);
    expect(cfg.stealthDriver).toBe('patchright');
    expect(cfg.humanize).toBe('on');
    expect(cfg.cdpDirect).toBe('auto');
    expect(cfg.autoPass).toBe('on');
    expect(cfg.aiSolve).toBe('on');
    expect(cfg.humanSolve).toBe('on');
    // challenge timeout raised to at least 30000 from the 15000 default.
    expect(cfg.challengeCompletionTimeoutMs).toBeGreaterThanOrEqual(30000);
  });

  it('explicit env override beats the hardcore preset (aiSolve)', () => {
    process.env.WIGOLO_HARDCORE = 'on';
    process.env.WIGOLO_AI_SOLVE = 'off';
    resetConfig();
    expect(getConfig().aiSolve).toBe('off');
  });

  it('explicit env override beats the hardcore preset (headful false)', () => {
    process.env.WIGOLO_HARDCORE = 'on';
    process.env.WIGOLO_BROWSER_HEADFUL = 'false';
    resetConfig();
    expect(getConfig().browserHeadful).toBe(false);
  });

  it('explicit env override beats the hardcore preset (stealthDriver playwright)', () => {
    process.env.WIGOLO_HARDCORE = 'on';
    process.env.WIGOLO_STEALTH_DRIVER = 'playwright';
    resetConfig();
    expect(getConfig().stealthDriver).toBe('playwright');
  });

  it('explicit persisted override beats the hardcore preset (autoPass off)', () => {
    process.env.WIGOLO_HARDCORE = 'on';
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: 1, settings: { autoPass: 'off' } }),
    );
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().autoPass).toBe('off');
  });

  it('a caller-supplied larger challenge timeout is not lowered by the preset', () => {
    process.env.WIGOLO_HARDCORE = 'on';
    process.env.WIGOLO_CHALLENGE_COMPLETION_MS = '45000';
    resetConfig();
    expect(getConfig().challengeCompletionTimeoutMs).toBe(45000);
  });

  it('hardcore off (default) leaves the anti-bot knobs at their normal defaults', () => {
    // No WIGOLO_HARDCORE set at all.
    resetConfig();
    const cfg = getConfig();
    expect(cfg.hardcore).toBe('off');
    expect(cfg.stealth).toBe('auto');
    // Both default to the CONSERVATIVE build/driver: an install must render
    // through the same pinned browser via the standard driver unless the
    // operator opts into host-installed Chrome / the hardened driver.
    expect(cfg.stealthDriver).toBe('playwright');
    expect(cfg.browserChannel).toBe('chromium');
    expect(cfg.browserHeadful).toBe(false);
    // Both rungs default OFF: reactive-only, so they never slow a successful
    // fetch, but they add time to one that ends up blocked anyway for no
    // measured win. Opt in per-knob.
    expect(cfg.humanize).toBe('off');
    expect(cfg.cdpDirect).toBe('off');
    expect(cfg.autoPass).toBe('off');
    expect(cfg.aiSolve).toBe('off');
    expect(cfg.humanSolve).toBe('off');
    expect(cfg.challengeCompletionTimeoutMs).toBe(15000);
  });

  it('does NOT touch proxyBypassOnChallenge (the preset owns no entry for it)', () => {
    // Assert the resolver is a no-op on this knob: with hardcore on and the knob
    // explicitly set false, it must stay false (the preset must not flip it).
    process.env.WIGOLO_HARDCORE = 'on';
    process.env.WIGOLO_PROXY_BYPASS_ON_CHALLENGE = 'false';
    resetConfig();
    expect(getConfig().proxyBypassOnChallenge).toBe(false);
  });
});
