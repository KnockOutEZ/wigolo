/**
 * The address notice as OBSERVED CLI OUTPUT (#322).
 *
 * The resolver has its own unit arms; these assert the thing the finding was
 * actually about — that a human running the command SEES it. Asserted over the
 * bytes the verb writes, never by reading config back, because "the config
 * holds a non-default address" was already true while every screen stayed
 * silent, and that is precisely the bug.
 *
 * The persisted arm goes through the REAL config resolution (a config.json in
 * a temp dir, `resetConfig()`, no env var) rather than through the injected
 * dep. Injecting the address proves the printer; only the disk round-trip
 * proves that the value `envStr` lifts out of `settings.accountsUrl` reaches
 * the printer at all, which is the half that had no notice.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { runAccountCommand, buildAccountDoctorLines } from '../../../src/cli/account.js';
import { accountsUrlOverride, ACCOUNTS_URL_ENV } from '../../../src/cli/accounts-url-notice.js';
import { PRODUCTION_ACCOUNTS_URL } from '../../../src/account/constants.js';
import { resetConfig } from '../../../src/config.js';

const OTHER = 'https://accounts.example.test';
const now = (): number => Date.parse('2026-09-02T10:00:00.000Z');

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-acct-url-'));
});

/** Lines mentioning the address, so "exactly one" is a countable claim. */
function noticeLines(text: string): string[] {
  return text.split('\n').filter((l) => l.includes('account service address'));
}

async function whoami(
  accountsUrl: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; text: string }> {
  const err = sink();
  const code = await runAccountCommand('whoami', [], {
    dataDir,
    ...(accountsUrl === undefined ? {} : { accountsUrl }),
    env,
    nowMs: now,
    stderr: err.stream,
    stdout: sink().stream,
  });
  return { code, text: err.text() };
}

describe('wigolo whoami — account service address notice', () => {
  it('prints exactly one notice naming the address and its persisted source', async () => {
    const { text } = await whoami(OTHER, {});
    const lines = noticeLines(text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(OTHER);
    expect(lines[0]).toContain('saved in this machine');
    expect(lines[0]).not.toContain(ACCOUNTS_URL_ENV);
  });

  it('says nothing on the shipped default address', async () => {
    const { text } = await whoami(PRODUCTION_ACCOUNTS_URL, {});
    expect(noticeLines(text)).toHaveLength(0);
    // Not vacuous — the verb did run and did write.
    expect(text).toContain('wigolo register');
  });

  it('reports the environment variable as the source when that is what set it', async () => {
    const { text } = await whoami(OTHER, { [ACCOUNTS_URL_ENV]: OTHER });
    const lines = noticeLines(text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ACCOUNTS_URL_ENV);
  });

  it('warns about cleartext for plain http off-machine, and not for loopback', async () => {
    const remote = await whoami('http://accounts.example.test', {});
    expect(noticeLines(remote.text)).toHaveLength(1);
    expect(remote.text).toContain('cleartext');

    const local = await whoami('http://127.0.0.1:8787', {});
    expect(noticeLines(local.text)).toHaveLength(1);
    expect(local.text).not.toContain('cleartext');

    const named = await whoami('http://localhost:8787', {});
    expect(noticeLines(named.text)).toHaveLength(1);
    expect(named.text).not.toContain('cleartext');
  });

  it('prints it on a machine that has never signed in, where the exposure starts', async () => {
    // This arm exits 1 through an early return. A notice placed after it would
    // be invisible on exactly the install about to hand an email address and a
    // sign-in code to the overridden host.
    const { code, text } = await whoami(OTHER, {});
    expect(code).toBe(1);
    expect(text).toContain('Not signed in');
    expect(noticeLines(text)).toHaveLength(1);
  });
});

describe('wigolo whoami — the persisted address, through real config resolution', () => {
  const saved = process.env[ACCOUNTS_URL_ENV];
  afterEach(() => {
    delete process.env.WIGOLO_CONFIG_PATH;
    if (saved === undefined) delete process.env[ACCOUNTS_URL_ENV];
    else process.env[ACCOUNTS_URL_ENV] = saved;
    resetConfig();
  });

  it('surfaces an address that exists only in config.json, with no env var anywhere', async () => {
    // THE SILENT HOLE. Nothing in the environment; the address lives on disk
    // and outlives every shell, and before this issue no surface said so.
    const cfgDir = mkdtempSync(join(tmpdir(), 'wigolo-acct-cfg-'));
    const cfgPath = join(cfgDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { accountsUrl: OTHER } }));
    process.env.WIGOLO_CONFIG_PATH = cfgPath;
    delete process.env[ACCOUNTS_URL_ENV];
    resetConfig();

    // No `accountsUrl` dep: the value must come off disk through getConfig().
    const { text } = await whoami(undefined, {});
    const lines = noticeLines(text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(OTHER);
    expect(lines[0]).toContain('saved in this machine');
  });
});

describe('doctor account section — account service address notice', () => {
  const emptyState = {
    account_id: null,
    email: null,
    entitlement_token: null,
    last_refresh_at: null,
    last_refresh_attempt_at: null,
    refresh_expires_at: null,
    needs_relogin: false,
    disclosure_version: null,
    marketing_consent: null,
  };
  const keys = { keys: [], overrideActive: false, notice: null };

  it('adds exactly one line for an overridden address and none for the default', () => {
    const overridden = buildAccountDoctorLines({
      state: { ...emptyState },
      keys,
      nowMs: now(),
      serviceKids: null,
      accountsUrl: accountsUrlOverride(OTHER, {}),
    });
    expect(noticeLines(overridden.join('\n'))).toHaveLength(1);
    expect(overridden.join('\n')).toContain(OTHER);

    const plain = buildAccountDoctorLines({
      state: { ...emptyState },
      keys,
      nowMs: now(),
      serviceKids: null,
      accountsUrl: accountsUrlOverride(PRODUCTION_ACCOUNTS_URL, {}),
    });
    expect(noticeLines(plain.join('\n'))).toHaveLength(0);
    // Not vacuous: the section still reported.
    expect(plain.join('\n')).toContain('Not signed in');
  });

  it('escalates the same line to cleartext for plain http off-machine', () => {
    const lines = buildAccountDoctorLines({
      state: { ...emptyState },
      keys,
      nowMs: now(),
      serviceKids: null,
      accountsUrl: accountsUrlOverride('http://accounts.example.test', {}),
    }).join('\n');
    expect(noticeLines(lines)).toHaveLength(1);
    expect(lines).toContain('cleartext');
  });
});
