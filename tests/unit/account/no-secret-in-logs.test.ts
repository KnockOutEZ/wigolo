/**
 * No credential reaches the logs — asserted at the LOUDEST log level.
 *
 * WHY THE LEVEL MATTERS. `createLogger` snapshots the configured level at
 * module-construction time, so a run at the default `info` would drop every
 * `log.debug` line in `client.ts` and `refresh.ts` — and this file would then
 * pass by never rendering the lines it exists to inspect. `WIGOLO_LOG_LEVEL` is
 * therefore pinned to `debug` and the account modules are imported AFTER it, so
 * every line the code can emit is actually written and searched.
 *
 * What is searched: the whole stderr stream produced by a full success path
 * plus a full failure path, against the refresh token, the access token, the
 * rotated replacement, the entitlement token and the email.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The env name is `LOG_LEVEL` (src/config.ts:751), not a `WIGOLO_`-prefixed one.
process.env.LOG_LEVEL = 'debug';
delete process.env.WIGOLO_TUI_MODE;

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

const { resetConfig, getConfig } = await import('../../../src/config.js');
resetConfig();

const { AccountsClient } = await import('../../../src/account/client.js');
const { storeRefreshToken, _resetAccessTokenCache } = await import('../../../src/account/token-store.js');
const { maybeRefresh } = await import('../../../src/account/refresh.js');

const BASE = 'http://127.0.0.1:8787';
const T0 = Date.parse('2026-09-01T12:00:00.000Z');

const SECRETS = {
  presented: 'refresh-PRESENTED-aaaa',
  rotated: 'refresh-ROTATED-bbbb',
  access: 'access-JWT-cccc',
  entitlement: 'v1.kid.ENTITLEMENT-dddd.sig',
  email: 'leaky@example.com',
};

let dataDir: string;
let captured: string;
let restore: () => void;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-acct-log-'));
  _resetAccessTokenCache();
  captured = '';
  const original = process.stderr.write.bind(process.stderr);
  const patched = ((chunk: unknown, ...rest: unknown[]) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  process.stderr.write = patched;
  restore = () => { process.stderr.write = original; };
});

afterEach(() => {
  restore();
  rmSync(dataDir, { recursive: true, force: true });
});

function assertNoSecrets(): void {
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(captured, `${name} leaked into the log stream`).not.toContain(value);
  }
}

describe('logging hygiene', () => {
  it('the logger is actually at debug for this file (otherwise the search is vacuous)', () => {
    // Anti-vacuity control: if the level were `info`, the debug lines this file
    // exists to inspect would never be written and every assertion below would
    // pass on an empty stream.
    expect(getConfig().logLevel).toBe('debug');
  });

  it('a successful rotation logs nothing containing a credential', async () => {
    await storeRefreshToken(SECRETS.presented, { dataDir });
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith('/entitlements/token')) {
        return new Response(
          JSON.stringify({ token: SECRETS.entitlement, valid_until: 'x', kid: 'kid' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: SECRETS.access,
          access_expires_in_s: 900,
          refresh_token: SECRETS.rotated,
          refresh_expires_at: '2026-12-01T00:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      nowMs: () => T0,
    });
    expect(out.status).toBe('refreshed');
    // The whole happy path is SILENT: there is no line to leak from, which is
    // the strongest form of the claim rather than a weaker "no match found".
    expect(captured).toBe('');
    assertNoSecrets();
  });

  it('a rejected refresh logs the code but not the token that was rejected', async () => {
    await storeRefreshToken(SECRETS.presented, { dataDir });
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: { code: 'refresh_reused', message: 'reuse detected' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });

    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      nowMs: () => T0,
    });
    expect(out.status).toBe('needs_relogin');
    // The code IS logged — it is what an operator needs.
    expect(captured).toContain('refresh_reused');
    assertNoSecrets();
  });

  it('a verify never logs the emailed code or the email', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: { code: 'invalid_code', message: 'nope' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });

    const client = new AccountsClient({ baseUrl: BASE, fetchImpl });
    const res = await client.verify({ email: SECRETS.email, code: '482913' });
    expect(res.ok).toBe(false);
    expect(captured).not.toContain('482913');
    assertNoSecrets();
  });

  it('a bearer call never logs the Authorization value', async () => {
    const fetchImpl = async (): Promise<Response> => { throw new Error('ECONNREFUSED 127.0.0.1:8787'); };
    const client = new AccountsClient({ baseUrl: BASE, fetchImpl });
    await client.entitlementsToken(SECRETS.access);
    expect(captured).not.toContain('Bearer');
    assertNoSecrets();
  });
});
