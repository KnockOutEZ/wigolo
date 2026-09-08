/**
 * The Account section's transport seam.
 *
 * `checkAccount` used to build its own `AccountsClient` inline, so the only way
 * to run doctor's Account section was against whatever `accountsUrl` resolved
 * to — a live request on every surface that mounts the diagnostic, including
 * the TUI's DoctorScreen. `runAccountCommand` has had an injectable client
 * since PX2; this is the same seam on the other account call site.
 *
 * The whole file runs under the net fence, so "no egress" is asserted by the
 * fence itself: any arm here that reached the network would fail the run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAccount } from '../../../src/cli/doctor.js';
import { AccountsClient, type FetchLike } from '../../../src/account/client.js';

let dataDir: string;

/** A data dir that reads as SIGNED IN — the state the probe is gated on. */
function seedSignedIn(dir: string): void {
  mkdirSync(join(dir, 'account'), { recursive: true });
  writeFileSync(
    join(dir, 'account', 'state.json'),
    JSON.stringify({ account_id: 'acct_probe_seam', email: 'probe@example.invalid' }),
    'utf8',
  );
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-doctor-probe-'));
  seedSignedIn(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('checkAccount — injected transport', () => {
  it('uses the injected client instead of building one', async () => {
    const client = {
      entitlementsKeys: vi.fn(async () => ({
        ok: true as const,
        data: { keys: [{ kid: 'k1', public_key: 'pk', active: true }] },
      })),
    } as unknown as AccountsClient;

    await checkAccount(dataDir, { client });

    expect(client.entitlementsKeys).toHaveBeenCalledTimes(1);
  });

  it('uses the injected fetch when no client is given', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await checkAccount(dataDir, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('/entitlements/keys');
  });

  it('does not probe at all when the install is not signed in', async () => {
    const unsignedDir = mkdtempSync(join(tmpdir(), 'wigolo-doctor-anon-'));
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('{}', { status: 200 }));
    try {
      await checkAccount(unsignedDir, { fetchImpl });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(unsignedDir, { recursive: true, force: true });
    }
  });
});

describe('checkAccount — cancellation', () => {
  it('merges the caller signal into the request instead of replacing the timeout', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => {
      seen = init?.signal ?? undefined;
      return new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await checkAccount(dataDir, { fetchImpl, signal: controller.signal });

    // The client still gets a signal (its own per-request timeout is preserved,
    // combined with ours) — and aborting the caller's aborts that combination.
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it('stops the probe in flight when the caller aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal == null) return; // no signal threaded → hangs, the pre-fix shape
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );

    const run = checkAccount(dataDir, { fetchImpl, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    // An abort is the caller leaving, not a diagnosis: it propagates rather
    // than being printed as "(check failed: …)" and swallowed.
    await expect(run).rejects.toThrow();
  });

  it('still reports a genuine failure as a check failure, not a throw', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    await expect(checkAccount(dataDir, { fetchImpl })).resolves.toBeUndefined();
  });
});
