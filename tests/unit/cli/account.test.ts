/**
 * The five account verbs (PX2 mini-spec §6).
 *
 * These are e2e-SHAPED unit tests: the real `AccountsClient` is driven by a
 * scripted transport, so every arm asserts over the bytes that would go on the
 * wire rather than over a hand-written double's recorded call. That matters for
 * the two arms this slice exists to pin — `login` must never carry
 * `marketing_consent`, and `register` must carry exactly what the toggle
 * answered — because "the field is absent" is a property of the REQUEST BODY,
 * and a mocked client method can be absent-of-argument while the body still
 * carries a key.
 *
 * The prompt sequence is driven by a PIPE, never a TTY (A-212-9): that is the
 * shape the RC gate uses, so it is the shape the tests use.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

vi.mock('../../../src/security/keychain.js', () => {
  const store = new Map<string, string>();
  return {
    WIGOLO_SERVICE: 'wigolo',
    keychainAvailable: vi.fn(() => true),
    keychainSet: vi.fn((service: string, user: string, value: string) => { store.set(`${service}:${user}`, value); }),
    keychainGet: vi.fn((service: string, user: string) => store.get(`${service}:${user}`) ?? null),
    keychainDelete: vi.fn((service: string, user: string) => { store.delete(`${service}:${user}`); }),
    _store: store,
  };
});

const keychainMod = await import('../../../src/security/keychain.js');
const { _store } = keychainMod as typeof keychainMod & { _store: Map<string, string> };

const { AccountsClient } = await import('../../../src/account/client.js');
const { AccountStateStore } = await import('../../../src/account/state.js');
const { storeRefreshToken, _resetAccessTokenCache } = await import('../../../src/account/token-store.js');
const { runAccountCommand, buildAccountDoctorLines, entitlementTokenKid } =
  await import('../../../src/cli/account.js');
const { resolvePinnedKeys } = await import('../../../src/account/pinned-keys.js');
const { generateMintKeyPair, mintToken, payload, grant } = await import('../account/mint-entitlement.js');

const BASE = 'http://127.0.0.1:8787';
const T0 = Date.parse('2026-09-02T10:00:00.000Z');
const now = (): number => T0;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Hit {
  path: string;
  method: string;
  /** Parsed request body, or `undefined` when the request carried none. */
  body: Record<string, unknown> | undefined;
  authorization: string | null;
}

type Handler = (hit: Hit) => Response;

function transport(routes: Record<string, Handler>): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  hits: Hit[];
} {
  const hits: Hit[] = [];
  return {
    hits,
    fetchImpl: async (url, init) => {
      const path = url.slice(BASE.length);
      const headers = new Headers(init?.headers ?? {});
      const hit: Hit = {
        path,
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
        authorization: headers.get('authorization'),
      };
      hits.push(hit);
      const handler = routes[path];
      if (!handler) throw new Error(`unscripted path: ${path}`);
      return handler(hit);
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const errJson = (status: number, code: string): Response => json(status, { error: { code, message: code } });

const DISCLOSURE_TEXT = 'wigolo collects usage and reliability telemetry, keyed to your account.';

const okRoutes = (entitlementToken: string): Record<string, Handler> => ({
  '/auth/request-code': () => json(200, {}),
  '/legal/telemetry-disclosure': () =>
    json(200, { text: DISCLOSURE_TEXT, version: '2026-08-01', updated_at: '2026-08-01T00:00:00.000Z' }),
  '/auth/verify': () =>
    json(200, {
      account: { id: 'acct_221', email: 'user@example.com', created_at: '2026-09-02T09:00:00.000Z' },
      access_token: 'access-1',
      access_expires_in_s: 900,
      refresh_token: 'refresh-1',
      refresh_expires_at: '2026-12-01T00:00:00.000Z',
      telemetry_disclosure: { text: DISCLOSURE_TEXT, version: '2026-08-01' },
    }),
  '/entitlements/token': () =>
    json(200, { token: entitlementToken, valid_until: '2026-09-09T00:00:00.000Z', kid: 'kid' }),
});

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

/** A pipe, never a TTY — the RC gate's shape. */
function pipedStdin(lines: readonly string[]): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8')]);
}

let dataDir: string;
const origEnv = process.env;

beforeEach(() => {
  _store.clear();
  _resetAccessTokenCache();
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-cli-account-'));
  process.env = { ...origEnv };
  delete process.env.WIGOLO_ACCOUNTS_PUBKEY;
});

afterEach(() => {
  process.env = origEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

describe('wigolo register', () => {
  it('walks the whole prompt sequence off a pipe and activates the install', async () => {
    const { fetchImpl, hits } = transport(okRoutes('v1.abcd1234.payload.sig'));
    const err = sink();
    const out = sink();

    const code = await runAccountCommand('register', ['--json'], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      // email, code, then an EMPTY line for the consent toggle: the default is Y
      // (§5 pin 8), and "just pressed enter" is the answer that exercises it.
      input: pipedStdin(['user@example.com', '654321', '']),
      stderr: err.stream,
      stdout: out.stream,
      nowMs: now,
    });

    expect(code).toBe(0);
    // Order matters: the disclosure is fetched and shown BEFORE the toggle is
    // asked, and the toggle is asked before anything is created.
    expect(hits.map((h) => h.path)).toEqual([
      '/auth/request-code',
      '/legal/telemetry-disclosure',
      '/auth/verify',
      '/entitlements/token',
    ]);

    const text = err.text();
    expect(text).toContain('Check your email for the sign-in code.');
    expect(text).toContain(DISCLOSURE_TEXT);
    expect(text).toContain('Send me occasional product updates by email? [Y/n]');
    expect(text).toContain('Account created.');
    expect(text).toContain('WIGOLO_TELEMETRY=off');

    const state = new AccountStateStore(dataDir).read();
    expect(state.account_id).toBe('acct_221');
    expect(state.email).toBe('user@example.com');
    expect(state.entitlement_token).toBe('v1.abcd1234.payload.sig');
    expect(state.disclosure_version).toBe('2026-08-01');
    expect(state.marketing_consent).toBe(true);
    expect(state.last_refresh_at).toBe(new Date(T0).toISOString());
    expect(_store.get('wigolo-account:refresh-token')).toBe('refresh-1');

    // --json house contract: exactly one document on stdout.
    const doc = JSON.parse(out.text().trim()) as Record<string, unknown>;
    expect(doc).toMatchObject({ status: 'ok', action: 'created', account_id: 'acct_221', marketing_consent: true });
  });

  it('carries the toggle ANSWER, not the default, when the user declines', async () => {
    const { fetchImpl, hits } = transport(okRoutes('v1.abcd1234.payload.sig'));
    const err = sink();

    const code = await runAccountCommand('register', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['user@example.com', '654321', 'n']),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });

    expect(code).toBe(0);
    const verify = hits.find((h) => h.path === '/auth/verify');
    expect(verify?.body).toMatchObject({ marketing_consent: false });
    expect(new AccountStateStore(dataDir).read().marketing_consent).toBe(false);
  });

  it('sends marketing_consent on the verify body — the field is present, not implied', async () => {
    const { fetchImpl, hits } = transport(okRoutes('v1.abcd1234.payload.sig'));
    await runAccountCommand('register', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['user@example.com', '654321', 'y']),
      stderr: sink().stream,
      stdout: sink().stream,
      nowMs: now,
    });
    const verify = hits.find((h) => h.path === '/auth/verify');
    expect(Object.keys(verify?.body ?? {})).toContain('marketing_consent');
    expect(verify?.body?.['marketing_consent']).toBe(true);
  });

  it('stops before creating anything when the served disclosure cannot be fetched', async () => {
    // The wording is SERVED, never client-bundled (PX1 §9). If we cannot show
    // it there is nothing to consent to, so the flow must not fall through to
    // verify with a locally-invented summary.
    const routes = okRoutes('v1.abcd1234.payload.sig');
    routes['/legal/telemetry-disclosure'] = () => errJson(503, 'unavailable');
    const { fetchImpl, hits } = transport(routes);
    const err = sink();

    const code = await runAccountCommand('register', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['user@example.com', '654321', '']),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });

    expect(code).toBe(1);
    expect(hits.map((h) => h.path)).not.toContain('/auth/verify');
    expect(err.text()).toContain('nothing was created');
    expect(new AccountStateStore(dataDir).read().account_id).toBeNull();
  });

  it('says "Signed in" rather than "Account created" when local state already knows an account', async () => {
    // Keyed on LOCAL PRIOR STATE only — the verify response does not flag
    // creation and PX2 does not extend the PX1 contract to make it.
    new AccountStateStore(dataDir).write({ account_id: 'acct_221', email: 'user@example.com' });
    const { fetchImpl } = transport(okRoutes('v1.abcd1234.payload.sig'));
    const err = sink();

    const code = await runAccountCommand('register', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['user@example.com', '654321', '']),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });

    expect(code).toBe(0);
    expect(err.text()).toContain('Signed in.');
    expect(err.text()).not.toContain('Account created.');
  });

  it('refuses to claim activation when the entitlement cannot be fetched', async () => {
    const routes = okRoutes('v1.abcd1234.payload.sig');
    routes['/entitlements/token'] = () => errJson(503, 'unavailable');
    const { fetchImpl } = transport(routes);
    const err = sink();

    const code = await runAccountCommand('register', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['user@example.com', '654321', '']),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });

    expect(code).toBe(1);
    expect(err.text()).toContain('not activated yet');
    // The credential IS kept, so the retry is one command rather than a fresh code.
    expect(_store.get('wigolo-account:refresh-token')).toBe('refresh-1');
  });

  it('takes the address from --email and asks only for the code', async () => {
    const { fetchImpl, hits } = transport(okRoutes('v1.abcd1234.payload.sig'));
    const code = await runAccountCommand('register', ['--email', 'flagged@example.com'], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['654321', '']),
      stderr: sink().stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(code).toBe(0);
    expect(hits[0]?.body).toMatchObject({ email: 'flagged@example.com' });
  });

  it('rejects an address that is not one before spending a round trip', async () => {
    const { fetchImpl, hits } = transport(okRoutes('v1.abcd1234.payload.sig'));
    const err = sink();
    const code = await runAccountCommand('register', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['not-an-address']),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(code).toBe(1);
    expect(hits).toHaveLength(0);
    expect(err.text()).toContain('does not look like an email address');
  });
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

describe('wigolo login', () => {
  it('NEVER sends marketing_consent, and never fetches the full disclosure', async () => {
    // Creation-only default: a `false` on sign-in would silently overwrite a
    // withdrawal the user made through the emailed unsubscribe link.
    const { fetchImpl, hits } = transport(okRoutes('v1.abcd1234.payload.sig'));
    const err = sink();

    const code = await runAccountCommand('login', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['user@example.com', '654321']),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });

    expect(code).toBe(0);
    const verify = hits.find((h) => h.path === '/auth/verify');
    expect(Object.keys(verify?.body ?? {})).not.toContain('marketing_consent');
    expect(hits.map((h) => h.path)).not.toContain('/legal/telemetry-disclosure');

    const text = err.text();
    expect(text).not.toContain('product updates by email?');
    expect(text).toContain('usage and reliability telemetry');
    expect(text).toContain('WIGOLO_TELEMETRY=off');
    expect(text).toContain('Signed in.');
  });

  it('leaves an existing recorded consent untouched', async () => {
    new AccountStateStore(dataDir).write({ marketing_consent: false, account_id: 'acct_221' });
    const { fetchImpl } = transport(okRoutes('v1.abcd1234.payload.sig'));
    await runAccountCommand('login', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['user@example.com', '654321']),
      stderr: sink().stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(new AccountStateStore(dataDir).read().marketing_consent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe('wigolo logout', () => {
  it('clears both credential tiers and the state, and says it is local-only', async () => {
    await storeRefreshToken('refresh-1', { dataDir });
    new AccountStateStore(dataDir).write({ account_id: 'acct_221', email: 'user@example.com' });
    const err = sink();
    const out = sink();

    const code = await runAccountCommand('logout', ['--json'], {
      dataDir,
      stderr: err.stream,
      stdout: out.stream,
      nowMs: now,
    });

    expect(code).toBe(0);
    expect(_store.get('wigolo-account:refresh-token')).toBeUndefined();
    expect(existsSync(join(dataDir, 'keys', 'account.enc'))).toBe(false);
    expect(new AccountStateStore(dataDir).read().account_id).toBeNull();
    // A-212-8: PX1 has no revocation endpoint. Saying "signed out everywhere"
    // would be the one thing worse than the gap.
    expect(err.text()).toContain('does not sign out other machines');
    expect(JSON.parse(out.text().trim())).toMatchObject({ status: 'ok', scope: 'local' });
  });

  it('reaches no network at all', async () => {
    const { fetchImpl, hits } = transport({});
    await runAccountCommand('logout', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      stderr: sink().stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

describe('wigolo whoami', () => {
  it('exits 1 and names the next step when the install was never activated', async () => {
    const err = sink();
    const code = await runAccountCommand('whoami', [], {
      dataDir,
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('wigolo register');
  });

  it('reports a perpetual grant offline, with no network of any kind', async () => {
    const keys = generateMintKeyPair();
    process.env.WIGOLO_ACCOUNTS_PUBKEY = keys.publicKeyB64Url;
    const minted = mintToken(keys, payload({ grants: [grant({ type: 'perpetual' })] }));
    new AccountStateStore(dataDir).write({
      account_id: 'acct_221',
      email: 'user@example.com',
      entitlement_token: minted.token,
      last_refresh_at: new Date(T0).toISOString(),
    });

    const { fetchImpl, hits } = transport({});
    const err = sink();
    const out = sink();
    const code = await runAccountCommand('whoami', ['--json'], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      env: process.env,
      stderr: err.stream,
      stdout: out.stream,
      nowMs: now,
    });

    expect(code).toBe(0);
    expect(hits).toHaveLength(0);
    expect(err.text()).toContain('Activation: perpetual');
    expect(err.text()).toContain('user@example.com');
    // The override is loud, always: a trust root that is not the shipped one
    // must never be invisible.
    expect(err.text()).toContain('custom sign-in verification key in use');
    expect(JSON.parse(out.text().trim())).toMatchObject({
      status: 'ok',
      activation: 'perpetual',
      custom_verification_key: true,
    });
  });

  it('names the grace deadline rather than just saying "ok"', async () => {
    const keys = generateMintKeyPair();
    process.env.WIGOLO_ACCOUNTS_PUBKEY = keys.publicKeyB64Url;
    const minted = mintToken(
      keys,
      payload({ grants: [grant({ type: 'subscription', expires: '2026-08-01T00:00:00.000Z' })], valid_until: '2026-08-20T00:00:00.000Z' }),
    );
    const lastRefresh = new Date(T0 - 3 * 24 * 60 * 60 * 1000).toISOString();
    new AccountStateStore(dataDir).write({
      account_id: 'acct_221',
      email: 'user@example.com',
      entitlement_token: minted.token,
      last_refresh_at: lastRefresh,
    });

    const err = sink();
    const code = await runAccountCommand('whoami', [], {
      dataDir,
      env: process.env,
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(code).toBe(0);
    expect(err.text()).toContain('Activation: in grace until 2026-09-13T10:00:00.000Z');
  });

  it('surfaces a dead refresh credential and when re-login falls due', async () => {
    const keys = generateMintKeyPair();
    process.env.WIGOLO_ACCOUNTS_PUBKEY = keys.publicKeyB64Url;
    const minted = mintToken(keys, payload());
    new AccountStateStore(dataDir).write({
      account_id: 'acct_221',
      email: 'user@example.com',
      entitlement_token: minted.token,
      needs_relogin: true,
      refresh_expires_at: '2026-12-01T00:00:00.000Z',
    });

    const err = sink();
    const code = await runAccountCommand('whoami', [], {
      dataDir,
      env: process.env,
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(code).toBe(0);
    expect(err.text()).toContain('wigolo login');
    expect(err.text()).toContain('2026-12-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// account
// ---------------------------------------------------------------------------

/** Routes for the subcommands, which all need a Bearer token minted by a refresh. */
function accountRoutes(entitlementToken: string, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    '/auth/refresh': () =>
      json(200, {
        access_token: 'access-2',
        access_expires_in_s: 900,
        refresh_token: 'refresh-2',
        refresh_expires_at: '2026-12-01T00:00:00.000Z',
      }),
    '/entitlements/token': () =>
      json(200, { token: entitlementToken, valid_until: '2026-09-09T00:00:00.000Z', kid: 'kid' }),
    '/account': () =>
      json(200, {
        id: 'acct_221',
        email: 'user@example.com',
        created_at: '2026-09-02T09:00:00.000Z',
        email_verified_at: '2026-09-02T09:01:00.000Z',
        consent: { marketing: true, marketing_updated_at: '2026-09-02T09:01:00.000Z' },
        telemetry: { disclosure_version: '2026-08-01', disclosed_at: '2026-09-02T09:01:00.000Z' },
      }),
    ...extra,
  };
}

async function seedSignedIn(token: string): Promise<void> {
  await storeRefreshToken('refresh-1', { dataDir });
  new AccountStateStore(dataDir).write({
    account_id: 'acct_221',
    email: 'user@example.com',
    entitlement_token: token,
  });
}

describe('wigolo account', () => {
  it('prints the summary, the cached grants and the consent-withdrawal route', async () => {
    const keys = generateMintKeyPair();
    process.env.WIGOLO_ACCOUNTS_PUBKEY = keys.publicKeyB64Url;
    const minted = mintToken(keys, payload({ grants: [grant({ product: 'core', type: 'perpetual' })] }));
    await seedSignedIn(minted.token);

    const { fetchImpl } = transport(accountRoutes(minted.token));
    const err = sink();
    const out = sink();
    const code = await runAccountCommand('account', ['--json'], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      env: process.env,
      stderr: err.stream,
      stdout: out.stream,
      nowMs: now,
    });

    expect(code).toBe(0);
    const text = err.text();
    expect(text).toContain('user@example.com');
    expect(text).toContain('Product-update emails: yes');
    expect(text).toContain('core · perpetual');
    expect(text).toContain('Telemetry:');
    // The day-one gap, said rather than implied: PX1 has no consent-write
    // endpoint a CLI could call (A-212-8).
    expect(text).toContain('unsubscribe link');

    const doc = JSON.parse(out.text().trim()) as { grants: Array<{ product: string }> };
    expect(doc.grants.map((g) => g.product)).toEqual(['core']);
  });

  it('tells an un-signed-in machine what to run instead of failing opaquely', async () => {
    const { fetchImpl } = transport(accountRoutes('v1.abcd1234.p.s'));
    const err = sink();
    const code = await runAccountCommand('account', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('wigolo login');
  });

  it('export writes the document to the named file', async () => {
    await seedSignedIn('v1.abcd1234.p.s');
    const exportDoc = { account: { id: 'acct_221' }, events: [{ kind: 'tool.run' }] };
    const { fetchImpl } = transport(accountRoutes('v1.abcd1234.p.s', { '/account/export': () => json(200, exportDoc) }));
    const target = join(dataDir, 'export.json');

    const err = sink();
    const code = await runAccountCommand('account', ['export', target], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(exportDoc);
    expect(err.text()).toContain(target);
  });

  it('export without a file name is a usage error, not a silent no-op', async () => {
    await seedSignedIn('v1.abcd1234.p.s');
    const { fetchImpl, hits } = transport(accountRoutes('v1.abcd1234.p.s'));
    const err = sink();
    const code = await runAccountCommand('account', ['export'], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(code).toBe(1);
    expect(hits).toHaveLength(0);
    expect(err.text()).toContain('Usage: wigolo account export <file>');
  });

  it('delete refuses anything but the literal confirmation', async () => {
    await seedSignedIn('v1.abcd1234.p.s');
    const { fetchImpl, hits } = transport(accountRoutes('v1.abcd1234.p.s'));
    const err = sink();

    const code = await runAccountCommand('account', ['delete'], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      // Lower case. A confirmation that folds case can be answered by reflex,
      // which is the whole thing it exists to prevent.
      input: pipedStdin(['delete']),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });

    expect(code).toBe(1);
    expect(hits.filter((h) => h.method === 'DELETE')).toHaveLength(0);
    expect(err.text()).toContain('Not deleted.');
    expect(_store.get('wigolo-account:refresh-token')).toBe('refresh-1');
  });

  it('delete on the literal calls DELETE /account and then signs this machine out', async () => {
    await seedSignedIn('v1.abcd1234.p.s');
    const { fetchImpl, hits } = transport(
      accountRoutes('v1.abcd1234.p.s', {
        // 204, no body — the real contract for `DELETE /account`.
        '/account': (hit) => (hit.method === 'DELETE' ? new Response(null, { status: 204 }) : json(200, {})),
      }),
    );
    const err = sink();
    const out = sink();

    const code = await runAccountCommand('account', ['delete', '--json'], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['DELETE']),
      stderr: err.stream,
      stdout: out.stream,
      nowMs: now,
    });

    expect(code).toBe(0);
    const del = hits.find((h) => h.method === 'DELETE');
    expect(del?.path).toBe('/account');
    expect(del?.authorization).toBe('Bearer access-2');
    expect(_store.get('wigolo-account:refresh-token')).toBeUndefined();
    expect(new AccountStateStore(dataDir).read().account_id).toBeNull();
    expect(JSON.parse(out.text().trim())).toMatchObject({ status: 'ok', deleted: true });
  });

  it('rejects an unknown subcommand instead of falling through to the summary', async () => {
    const { fetchImpl, hits } = transport(accountRoutes('v1.abcd1234.p.s'));
    const err = sink();
    const code = await runAccountCommand('account', ['nonsense'], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(code).toBe(1);
    expect(hits).toHaveLength(0);
    expect(err.text()).toContain("unknown subcommand 'nonsense'");
  });
});

// ---------------------------------------------------------------------------
// doctor section
// ---------------------------------------------------------------------------

describe('doctor account section', () => {
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

  it('names a rotation miss as one — pinned set, cached kid and service list side by side', async () => {
    // The diagnosis nobody can make from one line: this build does not pin the
    // key the service used, so the fix is an UPDATE and never a re-register.
    const shipped = generateMintKeyPair();
    const rotated = generateMintKeyPair();
    process.env.WIGOLO_ACCOUNTS_PUBKEY = shipped.publicKeyB64Url;
    const minted = mintToken(rotated, payload());

    const lines = buildAccountDoctorLines({
      state: { ...emptyState, account_id: 'acct_221', email: 'user@example.com', entitlement_token: minted.token },
      keys: resolvePinnedKeys(process.env),
      nowMs: T0,
      serviceKids: [rotated.kid],
      accountsUrl: null,
    });

    const text = lines.join('\n');
    expect(text).toContain(`Verification keys pinned: ${shipped.kid}`);
    expect(text).toContain(`Entitlement key: ${rotated.kid} — published by the service but NOT pinned by this build`);
    expect(text).toContain('Update wigolo');
    expect(text).toContain('Activation: update required');
  });

  it('says the service list was not checked rather than implying it was empty', () => {
    const lines = buildAccountDoctorLines({
      state: { ...emptyState },
      keys: resolvePinnedKeys(process.env),
      nowMs: T0,
      serviceKids: null,
      accountsUrl: null,
    });
    expect(lines.join('\n')).toContain('Service keys: not checked');
    expect(lines.join('\n')).toContain('Not signed in');
  });

  it('reads the kid of a token whose key is not held, which the verifier will not hand back', () => {
    expect(entitlementTokenKid('v1.deadbeef.cGF5.c2ln')).toBe('deadbeef');
    expect(entitlementTokenKid('v2.deadbeef.cGF5.c2ln')).toBeNull();
    expect(entitlementTokenKid('v1..cGF5.c2ln')).toBeNull();
    expect(entitlementTokenKid(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe('account verb copy', () => {
  it('never names an implementation dependency', async () => {
    const keys = generateMintKeyPair();
    process.env.WIGOLO_ACCOUNTS_PUBKEY = keys.publicKeyB64Url;
    const minted = mintToken(keys, payload());
    await seedSignedIn(minted.token);

    const { fetchImpl } = transport(accountRoutes(minted.token));
    const err = sink();
    const out = sink();
    for (const verb of ['whoami', 'account'] as const) {
      await runAccountCommand(verb, [], {
        dataDir,
        client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
        env: process.env,
        stderr: err.stream,
        stdout: out.stream,
        nowMs: now,
      });
    }

    const registerErr = sink();
    const { fetchImpl: regFetch } = transport(okRoutes(minted.token));
    await runAccountCommand('register', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: regFetch }),
      input: pipedStdin(['user@example.com', '654321', '']),
      stderr: registerErr.stream,
      stdout: sink().stream,
      nowMs: now,
    });

    const all = `${err.text()}\n${out.text()}\n${registerErr.text()}`;
    expect(all).not.toMatch(/playwright|searxng|flaresolverr|onnx|readability|defuddle|turndown|electron|sqlite|keytar/i);
  });
});

// ---------------------------------------------------------------------------
// Prompt transport
// ---------------------------------------------------------------------------

describe('prompting', () => {
  it('reads every answer off a single pipe — no TTY anywhere in the path', async () => {
    // A fresh reader per question would swallow the buffered lines behind it,
    // which is exactly how a scripted register loses its code.
    const { fetchImpl, hits } = transport(okRoutes('v1.abcd1234.payload.sig'));
    const code = await runAccountCommand('register', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['user@example.com', '654321', 'y']),
      stderr: sink().stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(code).toBe(0);
    expect(hits.find((h) => h.path === '/auth/verify')?.body).toMatchObject({ code: '654321' });
  });

  it('ends cleanly when the pipe runs dry mid-sequence', async () => {
    const { fetchImpl } = transport(okRoutes('v1.abcd1234.payload.sig'));
    const err = sink();
    const code = await runAccountCommand('register', [], {
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      input: pipedStdin(['user@example.com']),
      stderr: err.stream,
      stdout: sink().stream,
      nowMs: now,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('No sign-in code given.');
  });
});

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

describe('command wiring', () => {
  it('parses all five verbs as known commands', async () => {
    const { parseCommand } = await import('../../../src/cli/index.js');
    for (const verb of ['register', 'login', 'logout', 'whoami', 'account']) {
      expect(parseCommand([verb]).command).toBe(verb);
    }
    expect(parseCommand(['account', 'export', 'f.json']).args).toEqual(['export', 'f.json']);
  });
});
