/**
 * `<dataDir>/account/state.json` — permissions, atomicity, cross-process reads.
 *
 * The cross-process arm is the one that matters. Two `AccountStateStore`
 * instances hold no state of their own, so "a second instance sees the
 * rotation" is exactly the property a second PROCESS needs, and the refresh
 * policy's 30-second race branch is built on it. A per-process cache would
 * pass every other arm in this file and break that one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { AccountStateStore, accountStatePath, EMPTY_ACCOUNT_STATE } from '../../../src/account/state.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-acct-state-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('AccountStateStore', () => {
  it('reads an un-activated install when no file exists', () => {
    expect(new AccountStateStore(dataDir).read()).toEqual(EMPTY_ACCOUNT_STATE);
  });

  it('writes state.json under <dataDir>/account with 0600', () => {
    const store = new AccountStateStore(dataDir);
    store.write({ account_id: 'acct_1', email: 'a@example.com' });

    expect(store.path).toBe(join(dataDir, 'account', 'state.json'));
    expect(store.path).toBe(accountStatePath(dataDir));
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(store.path)).mode & 0o777).toBe(0o700);
  });

  it('merge-patches rather than replacing', () => {
    const store = new AccountStateStore(dataDir);
    store.write({ account_id: 'acct_1', email: 'a@example.com' });
    store.write({ needs_relogin: true });

    const s = store.read();
    expect(s.account_id).toBe('acct_1');
    expect(s.email).toBe('a@example.com');
    expect(s.needs_relogin).toBe(true);
  });

  it('leaves no temp file behind and writes through a rename', () => {
    const store = new AccountStateStore(dataDir);
    store.write({ entitlement_token: 'v1.k.p.s' });
    store.write({ entitlement_token: 'v1.k.p2.s2' });

    const entries = readdirSync(join(dataDir, 'account'));
    expect(entries).toEqual(['state.json']);
    // A direct (non-atomic) writeFileSync would also leave exactly this, so the
    // atomicity claim is carried by the temp-then-rename in `write` plus the
    // "no partial file is ever readable" arm below.
    expect(JSON.parse(readFileSync(store.path, 'utf8')).entitlement_token).toBe('v1.k.p2.s2');
  });

  it('replaces the file by rename, so no reader ever holds a truncated fd', () => {
    // The mechanical discriminator, not a vibe: `renameSync` swaps in a NEW
    // inode, so a reader that already opened the old one keeps reading a
    // complete old file. A truncating `writeFileSync` over the target reuses
    // the inode and that reader sees a half-file. Asserting the inode CHANGED
    // is therefore the atomic-write claim itself.
    const store = new AccountStateStore(dataDir);
    store.write({ account_id: 'acct_1' });
    const first = statSync(store.path).ino;
    store.write({ entitlement_token: 'token-A' });
    const second = statSync(store.path).ino;
    expect(second).not.toBe(first);
  });

  it('repeated writes always leave a complete, correctly sized document', () => {
    const writer = new AccountStateStore(dataDir);
    const reader = new AccountStateStore(dataDir);
    writer.write({ account_id: 'acct_1' });

    for (let i = 0; i < 50; i++) {
      writer.write({ entitlement_token: `token-${i}`.padEnd(4096, 'x') });
      const seen = reader.read();
      expect(seen.account_id).toBe('acct_1');
      expect(seen.entitlement_token).not.toBeNull();
      expect(seen.entitlement_token!.length).toBe(4096);
    }
  });

  it('a second store instance sees a rotation written by the first', () => {
    const first = new AccountStateStore(dataDir);
    first.write({ entitlement_token: 'token-A', refresh_expires_at: '2026-10-01T00:00:00.000Z' });

    const second = new AccountStateStore(dataDir);
    expect(second.read().entitlement_token).toBe('token-A');

    // The "other process" rotates.
    first.write({ entitlement_token: 'token-B', refresh_expires_at: '2026-12-01T00:00:00.000Z' });

    // The already-constructed instance must see it — no process-lifetime cache.
    expect(second.read().entitlement_token).toBe('token-B');
    expect(second.read().refresh_expires_at).toBe('2026-12-01T00:00:00.000Z');
  });

  it('an unparseable file reads as un-activated instead of throwing', () => {
    const store = new AccountStateStore(dataDir);
    mkdirSync(dirname(store.path), { recursive: true });
    writeFileSync(store.path, '{ not json', 'utf8');
    expect(store.read()).toEqual(EMPTY_ACCOUNT_STATE);
  });

  it('coerces wrong-typed and unknown keys rather than trusting the file', () => {
    const store = new AccountStateStore(dataDir);
    mkdirSync(dirname(store.path), { recursive: true });
    writeFileSync(
      store.path,
      JSON.stringify({
        account_id: 42,
        needs_relogin: 'yes',
        marketing_consent: 'true',
        entitlement_token: 'v1.k.p.s',
        surprise: { nested: true },
      }),
      'utf8',
    );

    const s = store.read();
    expect(s.account_id).toBeNull();
    expect(s.needs_relogin).toBe(false);
    expect(s.marketing_consent).toBeNull();
    expect(s.entitlement_token).toBe('v1.k.p.s');
    expect(Object.keys(s).sort()).toEqual(Object.keys(EMPTY_ACCOUNT_STATE).sort());
  });

  it('clear() resets to the un-activated state and keeps 0600', () => {
    const store = new AccountStateStore(dataDir);
    store.write({ account_id: 'acct_1', email: 'a@example.com', needs_relogin: true });
    store.clear();
    expect(store.read()).toEqual(EMPTY_ACCOUNT_STATE);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });
});
