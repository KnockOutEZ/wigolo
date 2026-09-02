/**
 * Credential transport floor for the accounts service (#329).
 *
 * The visible account-service notice is not the fence: background refresh and
 * telemetry calls have no terminal on which to print it. These tests pin the
 * client-level refusal, the two transport classes that remain allowed, and the
 * explicit env-only escape hatch used for deliberate LAN testing.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  AccountsClient,
  CLIENT_INSECURE_TRANSPORT,
  type FetchLike,
} from '../../../src/account/client.js';
import { ACCOUNTS_ALLOW_HTTP_ENV } from '../../../src/account/accounts-url-policy.js';
import { runAccountCommand } from '../../../src/cli/account.js';
import {
  ACCOUNTS_URL_ENV,
  accountsUrlOverride,
} from '../../../src/cli/accounts-url-notice.js';

const REMOTE_HTTP = 'http://accounts.example.test';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const REFRESH_OK = {
  access_token: 'access-2',
  access_expires_in_s: 900,
  refresh_token: 'refresh-2',
  refresh_expires_at: '2026-12-01T00:00:00.000Z',
};

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

describe('AccountsClient — credential transport floor', () => {
  it('fails refresh, verify and telemetry closed before fetch on remote cleartext HTTP', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes(500, {}));
    const client = new AccountsClient({ baseUrl: REMOTE_HTTP, fetchImpl, env: {} });

    const results = [
      await client.refresh('refresh-secret'),
      await client.verify({ email: 'user@example.com', code: '123456' }),
      await client.entitlementsToken('access.jwt'),
      await client.account('access.jwt'),
      await client.accountExport('access.jwt'),
      await client.deleteAccount('access.jwt'),
      await client.telemetryBatch('access.jwt', { events: [] }),
    ];

    expect(fetchImpl).not.toHaveBeenCalled();
    const notice = accountsUrlOverride(REMOTE_HTTP, {})?.notice;
    expect(notice).toBeDefined();
    for (const result of results) {
      expect(result).toEqual({
        ok: false,
        status: null,
        kind: 'policy',
        code: CLIENT_INSECURE_TRANSPORT,
        message: notice,
      });
    }
  });

  it.each([
    ['loopback HTTP', 'http://127.0.0.1:8787'],
    ['remote HTTPS', 'https://accounts.example.test'],
  ])('allows credential-bearing calls over %s', async (_label, baseUrl) => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes(200, REFRESH_OK));
    const client = new AccountsClient({ baseUrl, fetchImpl, env: {} });

    const result = await client.refresh('refresh-secret');

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('allows the call only for the exact env-only opt-out value', async () => {
    const allowedFetch = vi.fn<FetchLike>(async () => jsonRes(200, { accepted: 1 }));
    const allowed = new AccountsClient({
      baseUrl: REMOTE_HTTP,
      fetchImpl: allowedFetch,
      env: { [ACCOUNTS_ALLOW_HTTP_ENV]: '1' },
    });

    const result = await allowed.telemetryBatch('access.jwt', { events: [{}] });
    expect(result.ok).toBe(true);
    expect(allowedFetch).toHaveBeenCalledOnce();

    for (const value of ['', 'true', 'yes', ' 1 ']) {
      const refusedFetch = vi.fn<FetchLike>(async () => jsonRes(200, { accepted: 1 }));
      const refused = new AccountsClient({
        baseUrl: REMOTE_HTTP,
        fetchImpl: refusedFetch,
        env: { [ACCOUNTS_ALLOW_HTTP_ENV]: value },
      });
      const refusedResult = await refused.telemetryBatch('access.jwt', { events: [] });
      expect(refusedResult.ok).toBe(false);
      expect(refusedFetch).not.toHaveBeenCalled();
    }
  });

  it('keeps whoami loud while the opt-out is active', async () => {
    const env = {
      [ACCOUNTS_ALLOW_HTTP_ENV]: '1',
      [ACCOUNTS_URL_ENV]: REMOTE_HTTP,
    };
    const stderr = sink();

    await runAccountCommand('whoami', [], {
      accountsUrl: REMOTE_HTTP,
      dataDir: mkdtempSync(join(tmpdir(), 'wigolo-account-http-optout-')),
      env,
      stderr: stderr.stream,
      stdout: sink().stream,
    });

    const notice = accountsUrlOverride(REMOTE_HTTP, env)?.notice;
    expect(notice).toBeDefined();
    expect(stderr.text().split('\n')).toContain(notice);
    expect(notice).toContain(REMOTE_HTTP);
    expect(notice).toContain('cleartext');
  });
});
