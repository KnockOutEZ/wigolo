/**
 * The account-service address override, made visible (#322, PX1 exit-14 LOW).
 *
 * WHY THIS EXISTS. `accountsUrl` resolves from env OR from persisted settings
 * (`src/config.ts`, `envStr('WIGOLO_ACCOUNTS_URL', …, settings, 'accountsUrl')`)
 * and every account surface honours it. The trust-root half of the same
 * decision was deliberately made env-only AND printed out loud by
 * `whoami`/`doctor`, on the stated grounds that a `config --set` a user forgets
 * about must never move trust silently. The URL half had no notice at all: a
 * developer who once pointed the address at a test host and forgot ships their
 * email, sign-in code and 90-day refresh credential to that host on every
 * login and every refresh, forever, with nothing on any screen saying so.
 * Pinned keys stop entitlement forgery; they do not stop that.
 *
 * The arms are forced through PARAMETERS rather than by mutating the process,
 * matching `resolvePinnedKeys(env)`: the source half of the answer is a
 * property of (effective URL, env), and a test that mutated globals could not
 * tell "env said so" from "settings said so".
 */
import { describe, it, expect } from 'vitest';

import {
  ACCOUNTS_URL_ENV,
  accountsUrlOverride,
  accountsUrlNotice,
} from '../../../src/cli/accounts-url-notice.js';
import { PRODUCTION_ACCOUNTS_URL } from '../../../src/account/constants.js';

const OTHER = 'https://accounts.example.test';

describe('accountsUrlOverride', () => {
  it('says nothing at all when the address is the shipped default', () => {
    // The silent-eligible case, and the only one: a default install must not
    // grow a line that trains people to ignore this notice.
    expect(accountsUrlOverride(PRODUCTION_ACCOUNTS_URL, {})).toBeNull();
    expect(accountsUrlNotice(PRODUCTION_ACCOUNTS_URL, {})).toBeNull();
    // Even when the env var is what set it to the default.
    expect(accountsUrlOverride(PRODUCTION_ACCOUNTS_URL, { [ACCOUNTS_URL_ENV]: PRODUCTION_ACCOUNTS_URL })).toBeNull();
  });

  it('attributes a non-default address to PERSISTED SETTINGS when no env var is set', () => {
    // THE HOLE THIS ISSUE EXISTS FOR. No env var in the process, yet the
    // effective address is not the default — that can only have come off disk,
    // which is exactly the state nothing used to report.
    const over = accountsUrlOverride(OTHER, {});
    expect(over).not.toBeNull();
    expect(over?.source).toBe('settings');
    expect(over?.url).toBe(OTHER);
    expect(over?.notice).toContain(OTHER);
    expect(over?.notice).toContain('saved');
    expect(over?.notice).not.toContain(ACCOUNTS_URL_ENV);
  });

  it('attributes it to the environment variable when that is what set it', () => {
    // Same URL, different provenance, different line — because the FIX differs:
    // one is unset a variable, the other is edit a file that outlives the shell.
    const over = accountsUrlOverride(OTHER, { [ACCOUNTS_URL_ENV]: OTHER });
    expect(over?.source).toBe('env');
    expect(over?.notice).toContain(ACCOUNTS_URL_ENV);

    const settings = accountsUrlOverride(OTHER, {});
    expect(settings?.notice).not.toBe(over?.notice);
  });

  it('follows the resolver it is describing: a DEFINED env var owns the answer, even empty', () => {
    // `envStr` returns the env value when it is `!== undefined`, so an exported
    // but empty WIGOLO_ACCOUNTS_URL really does become the effective address.
    // Attributing that to settings would send the user hunting the wrong file.
    const over = accountsUrlOverride('', { [ACCOUNTS_URL_ENV]: '' });
    expect(over).not.toBeNull();
    expect(over?.source).toBe('env');
    // Unparseable, so no cleartext claim is made about it.
    expect(over?.insecure).toBe(false);
  });

  it('escalates to a cleartext warning for plain http to a host that is not this machine', () => {
    const over = accountsUrlOverride('http://accounts.example.test', {});
    expect(over?.insecure).toBe(true);
    expect(over?.notice).toContain('cleartext');
    expect(over?.notice).toContain('http://accounts.example.test');
    // Still ONE line: an escalation is a stronger sentence, not a second notice.
    expect(over?.notice.split('\n')).toHaveLength(1);
  });

  it('does not escalate for loopback http — the pinned PX1 local-RC mode', () => {
    // Refusing or shouting here would make local RC testing against a
    // locally-run accounts service noisy, and nothing leaves the machine.
    for (const url of [
      'http://127.0.0.1:8787',
      'http://127.0.0.1',
      'http://127.1.2.3:9000',
      'http://localhost:8787',
      'http://LOCALHOST:8787',
      'http://[::1]:8787',
    ]) {
      const over = accountsUrlOverride(url, {});
      expect(over, `${url} produced no notice`).not.toBeNull();
      expect(over?.insecure, `${url} escalated`).toBe(false);
      expect(over?.notice).not.toContain('cleartext');
    }
  });

  it('does not escalate https to a remote host — the transport is the thing being judged', () => {
    const over = accountsUrlOverride(OTHER, {});
    expect(over?.insecure).toBe(false);
    expect(over?.notice).not.toContain('cleartext');
  });

  it('names a capability, never a vendor or a library', () => {
    for (const env of [{}, { [ACCOUNTS_URL_ENV]: 'http://accounts.example.test' }]) {
      const notice = accountsUrlNotice('http://accounts.example.test', env) ?? '';
      expect(notice.length).toBeGreaterThan(0);
      expect(notice).toContain('account service address');
      expect(notice).not.toMatch(/playwright|electron|searxng|\bcdp\b/i);
    }
  });
});
