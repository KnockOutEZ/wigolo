/**
 * PX2 RC exit gate, every arm (mini-spec §13): a fresh install demands
 * registration, completes it against a locally-run accounts service, runs all
 * ten tools with nothing leaving this machine, sends zero telemetry when
 * telemetry is off, and refuses once a non-perpetual entitlement falls out of
 * both its own validity window and the fourteen-day grace.
 *
 * The whole file is one sequence on purpose. Each arm's precondition is the
 * previous arm's outcome — an install that has not refused has not proven it was
 * fresh, and tools that run before registration would prove the opposite of the
 * gate — so splitting them across files would mean re-paying a multi-minute
 * install to assert something the previous file already established.
 *
 * ORDER IS LOAD-BEARING AT THE TAIL. The telemetry arm needs a healthy activated
 * install, and the grace arm ENDS with one that is deliberately expired and a
 * service running on a back-dated clock. So telemetry runs first and grace runs
 * last; putting grace earlier would make every later arm test an install whose
 * activation had already been taken away from it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  delay,
  readOutboxCode,
  readOutboxMail,
  startAccountsService,
  startPostgresCluster,
  withServiceDatabase,
  type AccountsService,
  type PostgresCluster,
} from './rc-accounts-service.js';
import { accountsEnv, DAY_MS, RC_GATE_DISABLED, RC_GATE_SKIP_NOTICE } from './rc-gate-env.js';
import {
  blockedEgress,
  installTarball,
  packWigolo,
  runCli,
  type FreshInstall,
  type PackedTarball,
} from './rc-install.js';
import {
  startFixtureSite,
  startRecordingProxy,
  startStubSearchEngine,
  type FixtureSite,
  type RecordingProxy,
  type StubSearchEngine,
} from './rc-local-web.js';
import { startMcpSession, TEN_TOOLS, type McpSession } from './rc-mcp-client.js';

if (RC_GATE_DISABLED) console.warn(RC_GATE_SKIP_NOTICE);

/** The refusal a never-activated install must give, verbatim (`src/account/gate.ts`). */
const NEVER_ACTIVATED_LINE =
  'wigolo needs an account — run `wigolo register` to create one (already have one? `wigolo login`).';

/** The refusal step 6 must give, verbatim (`src/account/gate.ts` `ACTIVATION_REFUSALS`). */
const EXPIRED_LINE = 'Your wigolo sign-in has expired — run `wigolo login` to reconnect.';

/** `ACTIVATION_GRACE_MS` in `src/account/gate.ts`. Restated, not imported: the arms drive an
 *  INSTALLED tarball, and importing the constant from the working tree would let a change to
 *  the source move the test's own boundary with it. */
const GRACE_MS = 14 * DAY_MS;

/**
 * How far back the service's clock and the client's `last_refresh_at` are moved.
 *
 * Fifteen days is the smallest number that lands the fixture in the GAP between the two
 * layers this arm has to tell apart. The token's own window is seven days from `issued_at`
 * (`ENTITLEMENT_TOKEN_TTL_MS`), so a service minting at now-15d produces `valid_until` at
 * now-8d — step 4 is already out. Grace is fourteen days from `last_refresh_at`, so aging
 * that by fifteen puts step 5 out too. A smaller offset would leave one of the two steps
 * passing and the arm would agree with itself for the wrong reason; a much larger one would
 * satisfy every layer at once and stop distinguishing them.
 */
const BACKDATE_MS = 15 * DAY_MS;

/**
 * `FLUSH_EVENT_THRESHOLD` in `src/telemetry/client.ts` is 50 events, and each successful
 * tool call emits exactly one `tool.run`. Fifty-five calls therefore cross it with margin
 * on a long-lived surface, which is the only place the flush timer is armed
 * (`initSubsystems`; a CLI one-shot only ever appends).
 */
const TELEMETRY_BURN_CALLS = 55;

/**
 * How long each telemetry arm waits for a batch that may never come.
 *
 * Ninety seconds, and the number is not padding. `MIN_FLUSH_SPACING_MS` is 60 s and the
 * durable delivery state carries the previous flush's timestamp ACROSS processes, so a
 * session started right after arms 1-4 flushed is refused its own first attempt as `spaced`
 * for up to a minute. A shorter wait would make the ON arm flaky in exactly the direction
 * that quietly hollows out the OFF arm — a flip-test that fails to flip gets "fixed" by
 * deleting it.
 */
const TELEMETRY_SETTLE_MS = 90_000;

const EMAIL = 'px2-rc-gate@example.test';

describe.skipIf(RC_GATE_DISABLED)('PX2 RC exit gate — fresh install, registration, ten tools', () => {
  let cluster: PostgresCluster;
  let service: AccountsService;
  let proxy: RecordingProxy;
  let site: FixtureSite;
  let engine: StubSearchEngine;
  let tarball: PackedTarball;
  let full: FreshInstall;
  let omitOptional: FreshInstall;

  /** Set on every arm, so a forgotten variable reds instead of reaching a real host. */
  let env: Record<string, string>;

  /** The transcript the closing comment carries. */
  const transcript: string[] = [];
  const record = (heading: string, body: string): void => {
    transcript.push(`\n===== ${heading} =====\n${body.trim()}`);
  };

  beforeAll(async () => {
    cluster = await startPostgresCluster();
    await cluster.createDatabase('accounts');
    service = await startAccountsService({ databaseUrl: cluster.databaseUrl('accounts') });

    // Every client request goes through the recorder, including registration —
    // so the telemetry arm's counter is on the same door the account calls use.
    proxy = await startRecordingProxy(service.url);

    site = await startFixtureSite();
    engine = await startStubSearchEngine(site.url);

    env = {
      ...accountsEnv(proxy.url, service.publicKeyB64Url),
      // Opt into the sidecar backend and point it at the stub, so the search
      // family never resolves a real engine.
      WIGOLO_SEARCH: 'searxng',
      SEARXNG_URL: engine.url,
    };

    tarball = await packWigolo();
    full = await installTarball(tarball.path, { omitOptional: false });

    record(
      'service',
      `accounts service: ${service.url}\nkid: ${service.kid}\n` +
        `pubkey (base64url, raw Ed25519): ${service.publicKeyB64Url}\n` +
        `fixture site: ${site.url}\nstub search engine: ${engine.url}\nrecording front door: ${proxy.url}`,
    );
  }, 1_800_000);

  afterAll(async () => {
    await engine?.stop();
    await site?.stop();
    await proxy?.stop();
    await service?.stop();
    await cluster?.stop();

    if (transcript.length > 0) {
      // The demo artifact. Written to the run's output rather than to a file in
      // the repo: the closing comment needs it, and the tree must stay clean.
      console.info(`\n########## PX2 RC EXIT GATE TRANSCRIPT ##########${transcript.join('\n')}\n`);
    }
  }, 300_000);

  it('refuses the first tool run before registration, naming `wigolo register`', async () => {
    const result = await runCli(full, ['cache', '--stats'], { env });

    expect(result.code).toBe(1);
    expect(result.combined).toContain(NEVER_ACTIVATED_LINE);
    record('arm 2 — first tool run, unregistered (CLI)', `$ wigolo cache --stats\n${result.combined}`);
  }, 300_000);

  it('refuses every one of the ten tools over MCP before registration', async () => {
    const session = await startMcpSession(full, env);
    try {
      // The server serves the protocol and refuses per call (A-212-2), so a
      // successful handshake here is part of the assertion, not a precondition.
      const listed = await session.listTools();
      for (const tool of TEN_TOOLS) expect(listed).toContain(tool);

      const refusals: string[] = [];
      for (const tool of TEN_TOOLS) {
        const outcome = await session.call(tool, minimalArgs(tool, site.url));
        expect(outcome.text, `${tool} must refuse before registration`).toContain(
          NEVER_ACTIVATED_LINE,
        );
        refusals.push(`${tool}: ${outcome.text.split('\n')[0]}`);
      }
      record('arm 2 — all ten tools refused over MCP, unregistered', refusals.join('\n'));
    } finally {
      await session.stop();
    }
  }, 600_000);

  it('completes registration through the installed binary, with the code from the dev outbox', async () => {
    const result = await runCli(full, ['register', '--email', EMAIL], {
      env,
      // The code cannot be piped blind: it does not exist until the CLI has asked
      // for it. So the prompts are driven as prompts — write the code once the
      // service has actually delivered one (A-212-9 makes a pipe walk the same
      // path a keyboard does).
      onStarted: async (_child, write) => {
        const code = await readOutboxCode(service.dataDir, EMAIL);
        write(code);
        // The consent prompt defaults Y; answering it explicitly keeps the arm
        // independent of that default.
        write('y');
      },
    });

    expect(result.code).toBe(0);
    expect(result.combined).toContain('Account created.');

    const mail = await readOutboxMail(service.dataDir, EMAIL);
    record('arm 3 — dev outbox mail (the code a person would have read)', mail);
    record('arm 3 — registration', `$ wigolo register --email ${EMAIL}\n${result.combined}`);

    const state = await readState(full);
    expect(state.email).toBe(EMAIL);
    expect(state.entitlement_token).toMatch(/^v1\./);
    expect(state.needs_relogin).toBe(false);
    // The free grant is perpetual, which is what makes the perpetual arm of the
    // grace test meaningful later.
    expect(decodeGrants(state.entitlement_token)).toContainEqual(
      expect.objectContaining({ type: 'perpetual', expires: null }),
    );
  }, 600_000);

  it('records which credential-custody tier actually ran on the full install', async () => {
    const result = await runCli(full, ['whoami'], { env });

    expect(result.code).toBe(0);
    expect(result.combined).toContain(EMAIL);
    // The override is active in every arm, so the notice MUST be visible — a
    // support conversation must never happen against a moved trust root.
    expect(result.combined).toContain('custom sign-in verification key in use');

    const tier = await custodyTier(full);
    // Asserted rather than assumed: an optional-dep prebuild that failed silently
    // would otherwise leave this arm testing the file tier while claiming the
    // keychain one.
    expect(['keychain', 'encrypted-file']).toContain(tier);
    record('arm 1a — full install custody tier', `${tier}\n\n$ wigolo whoami\n${result.combined}`);
  }, 300_000);

  it('runs all ten tools against local servers only, once registered', async () => {
    const session = await startMcpSession(full, env);
    const summary: string[] = [];
    try {
      for (const tool of TEN_TOOLS) {
        if (tool === 'diff') {
          // A diff compares the CACHED copy against the live page, so the old
          // side has to be in the cache before the page changes. Relying on the
          // crawl to have happened to cache this URL is what produced
          // `error_reason: cache_miss`; the arm establishes the precondition
          // itself instead.
          const seeded = await session.call('fetch', { url: `${site.url}/changelog` });
          expect(seeded.isError, 'seeding the diff baseline failed').toBe(false);

          site.setPage(
            '/changelog',
            '<!doctype html><html><head><title>RC Fixture Changelog</title></head><body>' +
              '<main><h1>Changelog</h1><p>Version two of this page, with a new line that the ' +
              'first version did not carry at all.</p></main></body></html>',
          );
        }

        const outcome = await session.call(tool, minimalArgs(tool, site.url));

        expect(
          outcome.text,
          `${tool} must not refuse after registration. state.json now: ` +
            `${JSON.stringify(await readStateOrNull(full))}\nserver stderr tail:\n` +
            `${session.stderr().split('\n').slice(-25).join('\n')}`,
        ).not.toContain(NEVER_ACTIVATED_LINE);
        expect(outcome.text.length, `${tool} returned nothing`).toBeGreaterThan(0);

        // WHY THIS ASSERTION IS HERE. Without it the arm passed while `diff` and
        // `watch` were both answering `invalid_input` and doing no work at all:
        // "did not refuse and returned some bytes" is true of an error envelope.
        // A tool that reports a failure has not run, and this gate's clause is
        // that all ten RUN.
        expect(outcome.isError, `${tool} reported a tool error: ${firstLines(outcome.text, 4)}`).toBe(
          false,
        );
        expect(outcome.text, `${tool} returned an error envelope`).not.toContain('"error_reason"');

        // Each tool must show evidence of its OWN work, so a uniformly shaped
        // empty success cannot satisfy ten different clauses at once.
        expectToolDidItsWork(tool, outcome.text, site.url);

        summary.push(`--- ${tool} ---\n${firstLines(outcome.text, 6)}`);
      }

      // The search family reached the stub and nothing else: if it had fallen
      // through to a real engine the stub would show no queries.
      expect(engine.queries().length).toBeGreaterThan(0);
      // And the fetch family reached the fixture site.
      expect(site.hits()).toBeGreaterThan(0);

      // THE CLAUSE THIS ARM IS ACTUALLY ABOUT, AND WHAT IT CAN HONESTLY CLAIM.
      //
      // The gate says the measured arms are all-local. What is TRUE is that
      // nothing reached a non-loopback host: every such connection was blocked,
      // and all ten tools above produced their real results anyway, from the
      // fixture site and the stub engine alone.
      //
      // What is NOT true is that the install stopped trying. Measured on this
      // arm, with `WIGOLO_SEARCH=searxng` and `SEARXNG_URL` both set, it still
      // attempted www.bing.com, lite.duckduckgo.com, en.wikipedia.org,
      // www.mojeek.com and api2.marginalia-search.com, plus registry.npmjs.org
      // and storage.googleapis.com (the sidecar install and an embedding model).
      // `src/server.ts` seeds its direct engines unconditionally and the URL only
      // prepends the stub in front of them, so there is no configuration that
      // makes this install offline — only enforcement. Removing them is a `src/`
      // change this issue has no territory for; it is recorded in
      // `known-issues.md` instead.
      //
      // So the assertion is the one that matches reality and still has teeth:
      // nothing the fence let through was foreign, and the tools' own results
      // are local (asserted per tool above, which is what caught the leak).
      const blocked = await blockedEgress(full);
      const loopbackLeaks = blocked.filter((line) => /\b127\.|localhost|::1/.test(line));
      expect(
        loopbackLeaks,
        `the fence blocked something local, so the arms are testing the wrong thing:\n${loopbackLeaks.join('\n')}`,
      ).toEqual([]);

      record('arm 4 — all ten tools, registered', summary.join('\n\n'));
      record(
        'arm 4 — locality evidence',
        `stub search engine queries: ${engine.queries().length}\n` +
          `fixture site requests: ${site.hits()}\n` +
          `non-loopback connections BLOCKED by the egress fence: ${blocked.length}\n` +
          `distinct hosts it tried to reach: ${distinctHosts(blocked).join(', ') || '(none)'}\n` +
          `queries seen: ${engine.queries().slice(0, 8).join(' | ')}`,
      );
    } finally {
      await session.stop();
    }
  }, 1_200_000);

  it('forces the encrypted-file custody tier on an --omit=optional install and still registers and runs a tool', async () => {
    omitOptional = await installTarball(tarball.path, { omitOptional: true });

    const refused = await runCli(omitOptional, ['cache', '--stats'], { env });
    expect(refused.code).toBe(1);
    expect(refused.combined).toContain(NEVER_ACTIVATED_LINE);

    const email = 'px2-rc-omit@example.test';
    const registered = await runCli(omitOptional, ['register', '--email', email], {
      env,
      onStarted: async (_child, write) => {
        write(await readOutboxCode(service.dataDir, email));
        write('y');
      },
    });
    expect(registered.code).toBe(0);
    expect(registered.combined).toContain('Account created.');

    const ran = await runCli(omitOptional, ['cache', '--stats'], { env });
    expect(ran.code).toBe(0);

    const tier = await custodyTier(omitOptional);
    record(
      'arm 1b — --omit=optional install',
      `custody tier: ${tier}\n\n$ wigolo cache --stats (unregistered)\n${refused.combined}\n` +
        `\n$ wigolo register --email ${email}\n${registered.combined}` +
        `\n$ wigolo cache --stats (registered) → exit ${ran.code}`,
    );
  }, 1_800_000);

  it('sends ZERO requests to the telemetry endpoint with WIGOLO_TELEMETRY=off, and sends them when it is on', async () => {
    // Both arms start with the refresh throttle OPEN — see `openRefreshThrottle` for why
    // this, and not a priming `wigolo account`, is what lets a spawned server hold a Bearer.
    await openRefreshThrottle(full);

    const queuedBefore = await telemetryQueueDepth(full);
    // Arms 1-4 ran with telemetry at its default (ON, 0.3.0 is opt-OUT), so the counter
    // carries their requests. Zeroing it here is what makes the number below this arm's.
    proxy.reset();

    // ---- OFF -------------------------------------------------------------------------
    await burnTelemetryEvents(full, { ...env, WIGOLO_TELEMETRY: 'off' }, async () => {
      // The flush is fire-and-forget, so "none yet" and "none ever" are only the same
      // claim after the window in which one could have arrived. The ON arm below measures
      // how long that actually takes; this wait is deliberately longer.
      await delay(TELEMETRY_SETTLE_MS);
    });

    const offRequests = proxy.telemetryRequests();
    const queuedAfterOff = await telemetryQueueDepth(full);

    // THE GATE'S CLAUSE, ASSERTED AND NOT ARGUED (mini-spec §13). Not "the code has an if".
    expect(
      offRequests.length,
      `telemetry reached the endpoint with the switch off: ${JSON.stringify(offRequests)}`,
    ).toBe(0);
    // The independent second signal. Without it, a zero here would also be the reading for
    // "collected everything, just had not sent it yet" — which is not what off means.
    expect(queuedAfterOff, 'the off switch still wrote events to the disk queue').toBe(queuedBefore);

    // ---- ON, the flip that makes the zero above mean something ------------------------
    //
    // Same install, same tool calls, same starting state — including the same open
    // throttle, so the two arms differ in the switch and in nothing else.
    proxy.reset();
    await openRefreshThrottle(full);
    let onRequests: readonly { method: string; bodyBytes: number }[] = [];
    let deliveredInMs = -1;
    await burnTelemetryEvents(full, env, async () => {
      const startedAt = Date.now();
      const deadline = startedAt + TELEMETRY_SETTLE_MS;
      while (Date.now() < deadline && proxy.telemetryRequests().length === 0) {
        await delay(250);
      }
      onRequests = [...proxy.telemetryRequests()];
      deliveredInMs = Date.now() - startedAt;
    });

    // WHY THIS ASSERTION IS THE MOST IMPORTANT ONE IN THE ARM. A listener that can never
    // record anything reports zero for every input, and would have passed the OFF arm on a
    // build with telemetry ripped out entirely. This is the arm that proves the counter is
    // load-bearing, and the OFF arm is worth nothing without it.
    expect(
      onRequests.length,
      'telemetry did not reach the endpoint with the switch ON, so the zero measured with ' +
        'it OFF proves nothing about the switch',
    ).toBeGreaterThan(0);
    expect(onRequests.every((request) => request.method === 'POST')).toBe(true);
    expect(onRequests.every((request) => request.bodyBytes > 0)).toBe(true);

    record(
      'arm 6 — telemetry off = zero calls, flip-tested',
      `WIGOLO_TELEMETRY=off, ${TELEMETRY_BURN_CALLS} tool calls over MCP, ${TELEMETRY_SETTLE_MS}ms settle\n` +
        `  POST /telemetry/batch requests observed at the front door: ${offRequests.length}\n` +
        `  disk queue depth before: ${queuedBefore}, after: ${queuedAfterOff}\n` +
        `flip — telemetry at its default (on), same install, same ${TELEMETRY_BURN_CALLS} calls\n` +
        `  POST /telemetry/batch requests observed: ${onRequests.length} ` +
        `(first after ${deliveredInMs}ms, ${onRequests.map((r) => `${r.method} ${r.bodyBytes}B`).join(', ')})`,
    );
  }, 1_800_000);

  it('refuses when a non-perpetual entitlement is out of BOTH its validity window and grace, while a perpetual one survives the identical clock', async () => {
    // ---- move the service's clock, not the assertion ----------------------------------
    //
    // Revoking the grant and ageing `last_refresh_at` is NOT sufficient on its own: the
    // refresh that follows mints a token valid for another seven days, so step 4 passes and
    // grace is never consulted. Rather than soften the arm to whatever the API can reach,
    // the service is restarted on a back-dated clock through its own documented seam, so
    // the token it mints is already outside its window when the client stores it. The
    // front door keeps its URL across the restart, so `WIGOLO_ACCOUNTS_URL` is unchanged.
    const dataDir = service.dataDir;
    await service.stop();
    service = await startAccountsService({
      databaseUrl: cluster.databaseUrl('accounts'),
      // The same data dir means the same signing key and therefore the same `kid` — the
      // pinned override still verifies, so a refusal below is about expiry and can never be
      // the `update_required` arm wearing its clothes.
      dataDir,
      clockOffsetMs: -BACKDATE_MS,
    });
    proxy.setTarget(service.url);

    // ---- the perpetual arm, forced into the same corner --------------------------------
    const perpetualRefresh = await runCli(full, ['account'], { env });
    expect(perpetualRefresh.code, `refresh against the back-dated service failed:\n${perpetualRefresh.combined}`).toBe(0);
    const perpetualState = await ageLastRefresh(full, BACKDATE_MS);
    const perpetualPayload = decodePayload(perpetualState.entitlement_token);

    // THE FIXTURE HAS TO SIT IN THE GAP OR THE ARM PROVES NOTHING. If `valid_until` were
    // still ahead of now, step 4 would pass and this would be a test of token validity
    // wearing a perpetual grant's name; if the grace window still covered it, step 5 would.
    expect(
      Date.parse(perpetualPayload.valid_until),
      'the back-dated service minted a token that is still valid, so the perpetual arm would ' +
        'pass at step 4 and say nothing about perpetual grants',
    ).toBeLessThan(Date.now());
    expect(
      Date.now() - Date.parse(perpetualState.last_refresh_at ?? ''),
      'grace still covers this state, so the arm would pass at step 5',
    ).toBeGreaterThan(GRACE_MS);
    expect(perpetualPayload.grants).toContainEqual(expect.objectContaining({ type: 'perpetual' }));

    const perpetualRun = await runCli(full, ['cache', '--stats'], { env });
    // Brief §3: an offline machine keeps a perpetual grant for good.
    expect(perpetualRun.combined).not.toContain(EXPIRED_LINE);
    expect(perpetualRun.code, `a perpetual grant did not survive the aged clock:\n${perpetualRun.combined}`).toBe(0);

    // ---- take the perpetual grant away, and nothing else --------------------------------
    //
    // Raw SQL because PX1 exposes no endpoint that revokes a grant (PX1-G precedent). An
    // arm written against the API could only test a state the service will not enter.
    const liveGrants = await withServiceDatabase(service.databaseUrl, async (query) => {
      const accounts = await query('SELECT id FROM accounts WHERE email = $1', [EMAIL]);
      const accountId = accounts.rows[0]?.['id'];
      if (accountId === undefined) throw new Error(`no account row for ${EMAIL}`);

      await query(
        `UPDATE grants SET revoked_at = now()
          WHERE account_id = $1 AND type = 'perpetual' AND revoked_at IS NULL`,
        [accountId],
      );
      await query(
        `INSERT INTO grants (account_id, product, type, features, expires, created_at)
         VALUES ($1, 'core', 'subscription', '[]'::jsonb, now() + interval '30 days', now())`,
        [accountId],
      );

      const live = await query(
        `SELECT product, type FROM grants WHERE account_id = $1 AND revoked_at IS NULL
          ORDER BY product, created_at`,
        [accountId],
      );
      return live.rows;
    });
    expect(liveGrants).toEqual([{ product: 'core', type: 'subscription' }]);

    // ---- the subscription arm: identical clock, one variable changed --------------------
    const expiredRefresh = await runCli(full, ['account'], { env });
    expect(expiredRefresh.code, `refresh after the grant change failed:\n${expiredRefresh.combined}`).toBe(0);
    const expiredState = await ageLastRefresh(full, BACKDATE_MS);
    const expiredPayload = decodePayload(expiredState.entitlement_token);

    expect(
      expiredPayload.grants.some((grant) => grant.type === 'perpetual'),
      'the perpetual grant survived the revoke, so a refusal below could not be about grace',
    ).toBe(false);
    expect(expiredPayload.grants).toContainEqual(expect.objectContaining({ type: 'subscription' }));
    expect(Date.parse(expiredPayload.valid_until)).toBeLessThan(Date.now());
    expect(Date.now() - Date.parse(expiredState.last_refresh_at ?? '')).toBeGreaterThan(GRACE_MS);

    const refusedRun = await runCli(full, ['cache', '--stats'], { env });
    expect(refusedRun.code).toBe(1);
    expect(refusedRun.combined).toContain(EXPIRED_LINE);
    // WHICH refusal fired is the whole arm. `never_activated` is step 1/2 and would mean the
    // state or the signature broke — an earlier clause answering in step 6's place.
    expect(
      refusedRun.combined,
      'the install refused as never-activated, so the state or the pinned key broke rather ' +
        'than the entitlement expiring',
    ).not.toContain(NEVER_ACTIVATED_LINE);

    // ---- restore: the same binary, the same clock, the perpetual state back -------------
    await writeState(full, perpetualState);
    const restoredRun = await runCli(full, ['cache', '--stats'], { env });
    expect(
      restoredRun.code,
      `restoring the perpetual state did not restore the install, so the refusal above was ` +
        `not about the entitlement:\n${restoredRun.combined}`,
    ).toBe(0);

    record(
      'arm 5 — offline grace, forced clock',
      `service restarted with its clock at now-${BACKDATE_MS / DAY_MS}d; client last_refresh_at aged ${BACKDATE_MS / DAY_MS}d\n\n` +
        `perpetual grant — grants=${JSON.stringify(perpetualPayload.grants)}\n` +
        `  valid_until ${perpetualPayload.valid_until} (in the past), grace exhausted\n` +
        `  $ wigolo cache --stats → exit ${perpetualRun.code} (PASSES, brief §3)\n\n` +
        `after raw SQL revoke + subscription insert — live grants ${JSON.stringify(liveGrants)}\n` +
        `  grants=${JSON.stringify(expiredPayload.grants)}, valid_until ${expiredPayload.valid_until}\n` +
        `  $ wigolo cache --stats → exit ${refusedRun.code}\n${refusedRun.combined.trim()}\n\n` +
        `restore (perpetual state written back) → exit ${restoredRun.code}`,
    );
  }, 1_800_000);
});

interface AccountState {
  email: string | null;
  entitlement_token: string;
  last_refresh_at: string | null;
  needs_relogin: boolean;
  /**
   * Everything else the file carries.
   *
   * The grace arm writes the state back after editing one field, and the refresh
   * bookkeeping it does not name — `last_refresh_attempt_at`, `refresh_expires_at`,
   * `account_id` — is what keeps the 24 h throttle closed across the runs that follow. A
   * closed shape here would drop them on the write and the next one-shot would refresh,
   * undoing the ageing this arm exists to impose.
   */
  [key: string]: unknown;
}

/** The state as it is right now, or `null` — for a failure message, never a check. */
async function readStateOrNull(install: FreshInstall): Promise<AccountState | null> {
  try {
    return await readState(install);
  } catch {
    return null;
  }
}

async function readState(install: FreshInstall): Promise<AccountState> {
  const raw = await readFile(join(install.dataDir, 'account', 'state.json'), 'utf8');
  return JSON.parse(raw) as AccountState;
}

/**
 * Which store the refresh credential actually landed in.
 *
 * Observed from the filesystem rather than from a log line: the encrypted file
 * either exists or it does not, and that is the one signal neither tier can fake.
 */
async function custodyTier(install: FreshInstall): Promise<'keychain' | 'encrypted-file'> {
  try {
    await readFile(join(install.dataDir, 'keys', 'account.enc'));
    return 'encrypted-file';
  } catch {
    return 'keychain';
  }
}

interface EntitlementPayload {
  valid_until: string;
  grants: { product: string; type: string; expires: string | null }[];
}

/**
 * The payload inside a `v1.<kid>.<payload>.<sig>` entitlement token.
 *
 * Read here rather than asked of the CLI because every verb that would report it also
 * REFRESHES, which would re-stamp the `last_refresh_at` the grace arm just aged. The arms
 * assert on the state that actually reaches the gate, then assert on what the gate did
 * with it.
 */
function decodePayload(token: string): EntitlementPayload {
  const encoded = token.split('.')[2];
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<EntitlementPayload>;
  return { valid_until: decoded.valid_until ?? '', grants: decoded.grants ?? [] };
}

/** The grants inside an entitlement token. */
function decodeGrants(token: string): { type: string; expires: string | null }[] {
  return decodePayload(token).grants;
}

/** Write the state file back, whole. */
async function writeState(install: FreshInstall, state: AccountState): Promise<void> {
  await writeFile(
    join(install.dataDir, 'account', 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Move `last_refresh_at` back by `byMs` and return the state as it now stands.
 *
 * Editing the file is the honest way to force a fourteen-day boundary: the alternative is
 * to wait fourteen days, and the gate's own docstring says `now` is a parameter end-to-end
 * so that the boundary is forced rather than waited for. The returned value is the whole
 * file, so a caller can put it back byte-for-byte.
 */
async function ageLastRefresh(install: FreshInstall, byMs: number): Promise<AccountState> {
  const state = await readState(install);
  const anchorMs =
    state.last_refresh_at === null ? Date.now() : Date.parse(state.last_refresh_at);
  const aged: AccountState = {
    ...state,
    last_refresh_at: new Date(anchorMs - byMs).toISOString(),
  };
  await writeState(install, aged);
  return aged;
}

/**
 * Open the 24 h refresh throttle by clearing `last_refresh_attempt_at`.
 *
 * MEASURED, AND IT IS WHY THE FIRST RUN OF THIS ARM WENT RED. The access JWT is an
 * IN-PROCESS cache (`accessCache`, `src/account/token-store.ts:153`) — nothing about it
 * survives a process boundary — so a freshly spawned server holds none and `flush` falls
 * through to `maybeRefresh`, which allows one attempt per 24 h. Priming the arm with
 * `wigolo account` made it strictly worse: that verb FORCES a refresh and stamps
 * `last_refresh_attempt_at`, closing the throttle on the very session that needed it open,
 * and the ON arm sent nothing for a reason that had nothing to do with telemetry.
 *
 * Clearing the stamp is therefore the precondition, not a convenience, and both arms start
 * from it so the flip stays a single-variable comparison.
 */
async function openRefreshThrottle(install: FreshInstall): Promise<void> {
  const state = await readState(install);
  await writeState(install, { ...state, last_refresh_attempt_at: null });
}

/** How many events are sitting in the install's durable telemetry queue. */
async function telemetryQueueDepth(install: FreshInstall): Promise<number> {
  try {
    const raw = await readFile(join(install.dataDir, 'telemetry', 'queue.ndjson'), 'utf8');
    return raw.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    // No queue file is no events, which is the reading the off arm expects.
    return 0;
  }
}

/**
 * Run enough tool calls on a long-lived surface to cross the flush threshold, then hold the
 * session open while `settle` decides what happened.
 *
 * The settle runs INSIDE the session on purpose: the flush lives in the server process, so
 * stopping it first would kill the very request the ON arm is waiting for and the flip-test
 * would fail for a reason that has nothing to do with telemetry.
 */
async function burnTelemetryEvents(
  install: FreshInstall,
  env: Record<string, string>,
  settle: () => Promise<void>,
): Promise<void> {
  const session = await startMcpSession(install, env);
  try {
    for (let index = 0; index < TELEMETRY_BURN_CALLS; index += 1) {
      const outcome = await session.call('cache', { stats: true });
      expect(
        outcome.isError,
        `cache call ${index} failed, so fewer than ${TELEMETRY_BURN_CALLS} events were ` +
          `emitted: ${firstLines(outcome.text, 3)}`,
      ).toBe(false);
    }
    await settle();
  } finally {
    await session.stop();
  }
}

function firstLines(text: string, count: number): string {
  return text.split('\n').slice(0, count).join('\n');
}

/** The distinct hosts in a blocked-egress record, for the transcript. */
function distinctHosts(lines: readonly string[]): string[] {
  return [...new Set(lines.map((line) => line.split('\t')[1] ?? line))].sort();
}

/**
 * Evidence that a tool did the thing it is for.
 *
 * Ten identical "returned bytes" checks would let one shape satisfy every
 * clause, which is how `diff` and `watch` sat red inside a green arm. Each
 * predicate below names something only that tool's own work produces, and every
 * URL-shaped one requires the FIXTURE host — so a result sourced from anywhere
 * else fails here even if the fence somehow let it through.
 */
function expectToolDidItsWork(tool: string, text: string, siteUrl: string): void {
  const host = new URL(siteUrl).host;

  switch (tool) {
    case 'fetch':
      expect(text, 'fetch did not return the fixture page').toContain('RC Fixture Home');
      expect(text).toContain(host);
      break;
    case 'crawl':
      // More than the seed page: the crawl has to have followed a link.
      expect(text, 'crawl did not follow a link').toMatch(/\/(pricing|glossary|changelog)/);
      break;
    case 'extract':
      // The pricing table's own cells, so structured extraction really ran.
      expect(text, 'extract did not find the pricing table').toContain('Scale');
      break;
    case 'diff':
      // The page changed between the two reads, so a summary must report it.
      expect(text, 'diff reported no comparison').toMatch(/chang|added|removed|hunk|identical/i);
      break;
    case 'watch':
      // The `list` shape: a jobs collection, empty or not. No host assertion —
      // see `minimalArgs` for why this path is `list` and not `create`.
      expect(text, 'watch did not answer with a jobs listing').toMatch(/jobs|watch|count/i);
      break;
    case 'search':
      expect(text, 'search returned no stub result').toContain('activation gate');
      expect(text).toContain(host);
      break;
    case 'find_similar':
      expect(text, 'find_similar returned nothing from the local cache').toContain(host);
      break;
    case 'research':
      expect(text, 'research did not produce a brief').toMatch(/Research Brief|Key Findings|Sources/i);
      // The one that caught the live-internet leak: every source must be local.
      expectOnlyFixtureUrls(text, host, 'research');
      break;
    case 'agent':
      expectOnlyFixtureUrls(text, host, 'agent');
      break;
    case 'cache':
      expect(text, 'cache reported no stats').toMatch(/total_urls|stats/);
      break;
    default:
      throw new Error(`no work-evidence predicate defined for ${tool}`);
  }
}

/**
 * Every `http(s)://` in the text points at the fixture host.
 *
 * This is the assertion that would have failed the first run: a brief citing
 * `en.wikipedia.org` is a brief built from the public internet, whatever the
 * gate's prose claims.
 */
function expectOnlyFixtureUrls(text: string, host: string, tool: string): void {
  const urls = text.match(/https?:\/\/[^\s"'\\)\]]+/g) ?? [];
  const foreign = urls.filter((url) => {
    try {
      return new URL(url).host !== host;
    } catch {
      return false;
    }
  });
  expect(foreign, `${tool} cited non-local sources: ${foreign.slice(0, 5).join(', ')}`).toEqual([]);
}

/**
 * The smallest argument set that makes each tool do its real work.
 *
 * Every URL points at the fixture site and every query is answerable by the stub
 * engine, so a tool that ignored them and reached outward would be visible as a
 * missing hit on one of the two local counters rather than as a pass.
 */
function minimalArgs(tool: string, siteUrl: string): Record<string, unknown> {
  switch (tool) {
    case 'fetch':
      return { url: `${siteUrl}/` };
    case 'crawl':
      // `max_depth: 1` is the seed page and nothing else — the crawler's own
      // default is 2, and at 1 the arm was asserting over a one-page "crawl".
      return { url: siteUrl, max_pages: 4, max_depth: 2 };
    case 'extract':
      return { url: `${siteUrl}/pricing`, mode: 'structured' };
    case 'diff':
      // `old`/`new` are objects, not strings: the tool answered
      // "old.markdown, old.url or old.content_hash is required" to a bare string,
      // and the arm passed anyway because it only checked that SOMETHING came
      // back. The cached copy is the `old` side, the live page the `new` one.
      return {
        old: { url: `${siteUrl}/changelog` },
        new: { url: `${siteUrl}/changelog` },
        output: 'summary',
      };
    case 'watch':
      // NOT `create`. `watch` guards its URL at REGISTRATION time through
      // `src/watch/ssrf.ts`'s `guardUrl`, which — unlike the fetch-side guard —
      // takes no `allowPrivate` option and therefore refuses 127.0.0.0/8
      // outright, `WIGOLO_FETCH_ALLOW_PRIVATE` notwithstanding (measured:
      // "url resolves to a loopback / private IPv4"). That is deliberate: the
      // comment above it says a bad URL must never reach persistent state. So no
      // local fixture can ever be watched, and the only way to exercise `create`
      // would be a public URL — which is precisely the egress this gate forbids.
      // `list` runs the same tool through the same gate and does real work
      // against the jobs table, so the tool is covered and the create path's
      // local un-testability is recorded rather than papered over.
      return { action: 'list' };
    case 'search':
      return { query: 'activation gate registration' };
    case 'find_similar':
      return { url: `${siteUrl}/glossary` };
    case 'research':
      return { question: 'what does the activation gate require', depth: 'quick' };
    case 'agent':
      return { prompt: 'summarise the fixture site pricing plans', max_pages: 2, max_time_ms: 60_000 };
    case 'cache':
      return { stats: true };
    default:
      throw new Error(`no minimal arguments defined for ${tool}`);
  }
}
