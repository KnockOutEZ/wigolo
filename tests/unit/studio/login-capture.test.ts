import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLoginCapture,
  scopeStorageStateToOrigin,
  isEmptyStorageState,
  type ProfilePersist,
} from '../../../src/studio/login-capture.js';
import { ProfileStore, type ProfileKeychain } from '../../../src/studio/profile-store.js';
import type { StorageStateOut } from '../../../src/studio/session-browser.js';

const cookie = (name: string, domain: string, value = 'v'): StorageStateOut['cookies'][number] => ({
  name, value, domain, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
});
const ss = (cookies: StorageStateOut['cookies'], origins: StorageStateOut['origins'] = []): StorageStateOut => ({ cookies, origins });
const lsOrigin = (origin: string, kv: Record<string, string>): StorageStateOut['origins'][number] => ({
  origin,
  localStorage: Object.entries(kv).map(([name, value]) => ({ name, value })),
});

const WALL = 'https://acme.example';

// An in-memory keychain so the round-trip exercises the REAL ProfileStore (5c) encrypt→decrypt without the OS keychain.
function memKeychain(): ProfileKeychain {
  const m = new Map<string, string>();
  return { available: () => true, getKek: (id) => m.get(id) ?? null, setKek: (id, k) => { m.set(id, k); } };
}
const spyPersist = (): ProfilePersist & { calls: Array<{ profileId: string; boundOrigin: string; json: string }> } => {
  const calls: Array<{ profileId: string; boundOrigin: string; json: string }> = [];
  return { calls, set: vi.fn(async (profileId: string, boundOrigin: string, json: string) => { calls.push({ profileId, boundOrigin, json }); }) };
};

describe('scopeStorageStateToOrigin — RFC-6265 exact-host + dotted-parent-domain (keep wall-origin auth, drop unrelated)', () => {
  it('KEEPS a host-only cookie for the wall host', () => {
    const out = scopeStorageStateToOrigin(ss([cookie('session', 'acme.example')]), WALL);
    expect(out.cookies.map((c) => c.name)).toEqual(['session']);
  });

  it('KEEPS a dotted parent-domain cookie (.acme.example) — the auth-cookie case (NOT-too-strict)', () => {
    const out = scopeStorageStateToOrigin(ss([cookie('auth', '.acme.example')]), WALL);
    expect(out.cookies.map((c) => c.name)).toEqual(['auth']); // a real auth cookie is often parent-dotted
  });

  it('DROPS an unrelated origin\'s cookie (NOT-too-loose)', () => {
    const out = scopeStorageStateToOrigin(ss([cookie('ga', 'tracker.example')]), WALL);
    expect(out.cookies).toEqual([]);
  });

  it('DROPS a sibling-subdomain cookie the wall host would not receive (api.acme.example) — the chosen rule is tighter than registrable-domain', () => {
    const out = scopeStorageStateToOrigin(ss([cookie('apikey', 'api.acme.example')]), WALL);
    expect(out.cookies).toEqual([]); // github.com would not receive an api.github.com-domain cookie
  });

  it('mixed set → keeps ONLY the wall host + dotted-parent cookies', () => {
    const out = scopeStorageStateToOrigin(
      ss([cookie('session', 'acme.example'), cookie('auth', '.acme.example'), cookie('ga', 'tracker.example'), cookie('x', 'evil.example')]),
      WALL,
    );
    expect(out.cookies.map((c) => c.name).sort()).toEqual(['auth', 'session']);
  });

  it('localStorage is EXACT-origin: keeps the wall origin, drops other origins', () => {
    const out = scopeStorageStateToOrigin(
      ss([], [lsOrigin('https://acme.example', { token: 't' }), lsOrigin('https://tracker.example', { gid: 'y' })]),
      WALL,
    );
    expect(out.origins.map((o) => o.origin)).toEqual(['https://acme.example']);
  });

  it('an undefined/invalid wall origin scopes to NOTHING (can\'t scope ⇒ keep nothing ⇒ the L3-2 backstop blocks persist)', () => {
    expect(scopeStorageStateToOrigin(ss([cookie('session', 'acme.example')]), undefined)).toEqual({ cookies: [], origins: [] });
  });
});

describe('isEmptyStorageState', () => {
  it('empty cookies + empty localStorage → empty', () => {
    expect(isEmptyStorageState(ss([]))).toBe(true);
    expect(isEmptyStorageState(ss([], [lsOrigin('https://acme.example', {})]))).toBe(true); // origin present but no keys
  });
  it('a cookie OR a localStorage key → not empty', () => {
    expect(isEmptyStorageState(ss([cookie('s', 'acme.example')]))).toBe(false);
    expect(isEmptyStorageState(ss([], [lsOrigin('https://acme.example', { t: '1' })]))).toBe(false);
  });
});

describe('createLoginCapture — origin-scope then persist (onComplete fill)', () => {
  it('L6a NOT-too-loose: the persisted profile contains ONLY the wall-origin state — an unrelated cookie never lands', async () => {
    // MUTATION (persist the UNSCOPED ctx.storageState): the tracker cookie lands in the profile → RED.
    const persist = spyPersist();
    const capture = createLoginCapture({ profilePersist: persist, profileId: 'p1', expectedOrigin: WALL });
    await capture({
      storageState: ss([cookie('session', 'acme.example'), cookie('ga', 'tracker.example')]),
      wallOrigin: WALL,
    });
    expect(persist.set).toHaveBeenCalledTimes(1);
    const json = persist.calls[0].json;
    expect(json).toContain('session'); // the wall cookie is persisted…
    expect(json).not.toContain('tracker.example'); // …the unrelated origin is NOT
    expect(json).not.toContain('"ga"');
  });

  it('L6a NOT-too-strict: a dotted-domain (.acme.example) auth cookie IS retained in the persisted state (reuse would authenticate)', async () => {
    // MUTATION (scope to EXACT-origin-only, dropping dotted-domain): the .acme.example auth cookie is
    // dropped → reuse would not authenticate → RED.
    const persist = spyPersist();
    const capture = createLoginCapture({ profilePersist: persist, profileId: 'p1', expectedOrigin: WALL });
    await capture({ storageState: ss([cookie('auth', '.acme.example')]), wallOrigin: WALL });
    expect(persist.set).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(persist.calls[0].json) as StorageStateOut;
    expect(parsed.cookies.map((c) => c.name)).toEqual(['auth']); // the parent-dotted auth cookie survives the scope
  });

  it('L3-2 persist-side backstop: an empty/unchanged wall-origin scoped state → NO persist (no no-auth profile)', async () => {
    // MUTATION (persist unconditionally): an empty scoped state is persisted → RED.
    const persist = spyPersist();
    const capture = createLoginCapture({ profilePersist: persist, profileId: 'p1' });
    // The only cookies are for OTHER origins → after scoping the wall origin has nothing.
    await capture({ storageState: ss([cookie('ga', 'tracker.example')]), wallOrigin: WALL });
    expect(persist.set).not.toHaveBeenCalled();
  });

  it('PIN-A2 (never-skip): with NO bound origin, a real wall-origin login is REFUSED persist (the undefined-skip is gone)', async () => {
    // Slice D2/A: removing the `deps.expectedOrigin !== undefined` skip at login-capture.ts:115 makes an
    // UNBOUND capture FAIL-CLOSED — a named profile with no bound origin must never persist. value-flip RED:
    // today undefined ⇒ the skip is taken ⇒ the scoped state persists.
    // MUTATION (restore the `deps.expectedOrigin !== undefined &&` skip): undefined bypasses the match ⇒ persists ⇒ RED.
    const persist = spyPersist();
    const capture = createLoginCapture({ profilePersist: persist, profileId: 'p1' }); // no expectedOrigin
    await capture({ storageState: ss([cookie('session', 'acme.example')]), wallOrigin: WALL });
    expect(persist.set).not.toHaveBeenCalled();
  });

  it('round-trip: a real ctx → ProfileStore.set the scoped JSON; 5c\'s get returns it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-logincap-'));
    try {
      const store = new ProfileStore({ dataDir: dir, keychain: memKeychain() });
      const capture = createLoginCapture({ profilePersist: store, profileId: 'gh', expectedOrigin: WALL });
      await capture({
        storageState: ss([cookie('session', 'acme.example'), cookie('ga', 'tracker.example')], [lsOrigin('https://acme.example', { tok: 'x' })]),
        wallOrigin: WALL,
      });
      const got = await store.get('gh');
      expect(got.ok).toBe(true);
      if (got.ok) {
        const parsed = JSON.parse(got.storageState) as StorageStateOut;
        expect(parsed.cookies.map((c) => c.name)).toEqual(['session']); // scoped: wall cookie kept, tracker dropped
        expect(parsed.origins.map((o) => o.origin)).toEqual(['https://acme.example']);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
