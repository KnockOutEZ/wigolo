/**
 * PX2 RC exit gate, arms 1-4 (mini-spec §13): a fresh install demands
 * registration, completes it against a locally-run accounts service, and then
 * runs all ten tools with nothing leaving this machine.
 *
 * The whole file is one sequence on purpose. Each arm's precondition is the
 * previous arm's outcome — an install that has not refused has not proven it was
 * fresh, and tools that run before registration would prove the opposite of the
 * gate — so splitting them across files would mean re-paying a multi-minute
 * install to assert something the previous file already established.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  readOutboxCode,
  readOutboxMail,
  startAccountsService,
  startPostgresCluster,
  type AccountsService,
  type PostgresCluster,
} from './rc-accounts-service.js';
import { accountsEnv, RC_GATE_DISABLED, RC_GATE_SKIP_NOTICE } from './rc-gate-env.js';
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
});

interface AccountState {
  email: string | null;
  entitlement_token: string;
  last_refresh_at: string | null;
  needs_relogin: boolean;
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

/** The grants inside a `v1.<kid>.<payload>.<sig>` entitlement token. */
function decodeGrants(token: string): { type: string; expires: string | null }[] {
  const payload = token.split('.')[2];
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    grants?: { type: string; expires: string | null }[];
  };
  return decoded.grants ?? [];
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
