/**
 * MCP dispatch on an UNREGISTERED install (PX brief §0a.1-3, issue #336).
 *
 * THIS FILE USED TO PIN THE OPPOSITE. Under PX2 every arm here asserted that an
 * install with no account was refused at `tools/call` with one of three pinned
 * lines. The CEO consulting pass of 2026-09-03 made the hard gate Studio-only,
 * so each of those arms is now inverted: the same fixtures, the same fresh empty
 * data dir, and the assertion that the call goes THROUGH.
 *
 * WHAT THESE ARMS ARE ACTUALLY ABOUT — three properties that can really break:
 *
 *   1. NOTHING IS WALLED. Every one of the ten tools dispatches with no account,
 *      and no refusal line reaches any result. Asserting one successful call
 *      would not catch a gate reintroduced on one tool, so the sweep is over all
 *      ten and it greps the refusal text out of the whole result.
 *   2. THE WATCH PATH RUNS. PX2's gate sat deliberately ABOVE
 *      `scheduleOverdueCheck` so a refused call could not egress. With the gate
 *      gone the scheduler is reachable unregistered, and the arm proves it fires
 *      — the same recorder, the same overdue job, now expected to be touched.
 *   3. THE NUDGE FIRES ONCE. Not on run N-1, once on run N, never again, never
 *      on a failed call, never on a registered install. That is the whole of
 *      §0a.2's "never repeated", and it is a property of the disk, so the arms
 *      drive real successive calls against a real data dir.
 *
 * The gate SEAM itself is untouched and still unit-tested in
 * `tests/unit/account/gate.test.ts` — Studio and the unlock story both consume
 * it. What no longer exists is a core call site that turns its answer into a
 * refusal, and the sweep in arm 1 is what would catch one coming back.
 *
 * The data dir is repointed at an empty directory, so "unregistered" is the real
 * condition (no state file) rather than a stubbed decision. The suite as a whole
 * runs activated (see `tests/setup.ts`), which is exactly why these arms have to
 * build their own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetConfig } from '../../../src/config.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { ACTIVATION_REFUSALS } from '../../../src/account/gate.js';
import { setActivationChecker } from '../../../src/server/activation.js';
import { UNLOCK_NOTICE, WIGOLO_INSTRUCTIONS, serverInstructions } from '../../../src/instructions.js';
import { NUDGE_AFTER_RUNS, nudgeStatePath } from '../../../src/account/nudge.js';
import { REGISTRATION_UNLOCKS, UNREGISTERED_RUNS_LINE } from '../../../src/account/unlocks.js';
import { generateMintKeyPair, mintToken, grant, payload } from '../account/mint-entitlement.js';
import { installChecker, sourceFor, subscriptionAccount } from './activation-fixture.js';

vi.mock('../../../src/cache/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cache/db.js')>(
    '../../../src/cache/db.js',
  );
  return { ...actual, initDatabase: (_path?: string) => actual.initDatabase(':memory:') };
});

vi.mock('../../../src/fetch/browser-pool.js', () => {
  class MockMultiBrowserPool {
    shutdown = vi.fn().mockResolvedValue(undefined);
    fetchWithBrowser = vi.fn();
    getConfiguredTypes = vi.fn().mockReturnValue(['chromium']);
    getStats = vi.fn().mockReturnValue([]);
  }
  return {
    MultiBrowserPool: MockMultiBrowserPool,
    BrowserPool: class MockBrowserPool extends MockMultiBrowserPool {
      acquire = vi.fn();
      release = vi.fn();
    },
  };
});

vi.mock('../../../src/fetch/http-client.js', () => ({ httpFetch: vi.fn() }));

vi.mock('../../../src/fetch/router.js', () => ({
  SmartRouter: class MockSmartRouter {
    constructor(_httpClient: unknown, _browserPool: unknown) {}
    fetch = vi.fn();
    getDomainStats = vi.fn();
  },
}));

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  resolveSearchBackend: vi.fn().mockResolvedValue({ type: 'scraping' }),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/searxng/process.js', () => ({
  SearxngProcess: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
    getUrl: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../../../src/searxng/docker.js', () => ({
  DockerSearxng: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({
    init: vi.fn().mockResolvedValue(undefined),
    isAvailable: () => false,
    shutdown: vi.fn(),
  }),
  resetEmbeddingService: vi.fn(),
}));

// THE EGRESS RECORDER. The watch scheduler reaches the network through exactly
// one call — `handleFetch` in `runCheck` — so a spy here is the whole of the
// side effect the gate's placement exists to prevent.
const fetchCalls = vi.hoisted(() => ({ spy: vi.fn() }));
vi.mock('../../../src/tools/fetch.js', () => ({
  handleFetch: (...args: unknown[]) => {
    fetchCalls.spy(...args);
    return Promise.resolve({ ok: false, error: 'stub', error_reason: 'internal' });
  },
}));

// THE REST OF THE TEN, STUBBED AT THE HANDLER. The ten-tool sweep below asserts
// something about DISPATCH, not about any tool's behaviour, and six of the ten
// reach the network on the way to their own answer — which the suite's net fence
// correctly refuses. Stubbing the handlers is what lets the sweep be over all ten
// rather than over the four that happen to be local: the assertion is that the
// call reaches a handler at all and comes back without a refusal, and a stub that
// returns a plain result proves exactly that.
vi.mock('../../../src/tools/search.js', () => ({
  handleSearch: () => Promise.resolve({ ok: true, data: { results: [], query: 'stub' } }),
}));
vi.mock('../../../src/tools/crawl.js', () => ({
  handleCrawl: () => Promise.resolve({ pages: [], total_found: 0, crawled: 0 }),
}));
vi.mock('../../../src/tools/extract.js', () => ({
  handleExtract: () => Promise.resolve({ ok: true, data: { url: 'https://example.invalid/x' } }),
}));
vi.mock('../../../src/tools/find-similar.js', () => ({
  handleFindSimilar: () => Promise.resolve({ ok: true, data: { results: [] } }),
}));
vi.mock('../../../src/tools/research.js', () => ({
  handleResearch: () => Promise.resolve({ ok: true, data: { brief: { topics: [] } } }),
}));
vi.mock('../../../src/tools/agent.js', () => ({
  handleAgent: () => Promise.resolve({ ok: true, data: { steps: [] } }),
}));

async function connectClient() {
  const { initSubsystems, createMcpServer } = await import('../../../src/server.js');
  const subs = await initSubsystems();
  const server = createMcpServer(subs);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    teardown: async () => {
      await client.close();
      await server.close();
      await subs.shutdown();
    },
  };
}

/** First text block of a CallToolResult. Takes `unknown` because the SDK's own
 *  result type carries an index signature the narrower shape cannot absorb. */
function textOf(res: unknown): string {
  const blocks = (res as { content?: Array<{ text?: string }> }).content;
  return blocks?.[0]?.text ?? '';
}

/** Let the `setImmediate` the scheduler defers through actually run. */
async function flushImmediates(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('MCP tools/call on an unregistered install', () => {
  let tmpDataDir: string;
  let savedPubkey: string | undefined;
  const mintKeys = generateMintKeyPair();

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'wigolo-activation-'));
    process.env.WIGOLO_DATA_DIR = tmpDataDir;
    // Pin verification to this file's own key so the "register mid-flight" arm
    // can mint a token the running server will actually accept.
    savedPubkey = process.env.WIGOLO_ACCOUNTS_PUBKEY;
    process.env.WIGOLO_ACCOUNTS_PUBKEY = mintKeys.publicKeyB64Url;
    resetConfig();
    // Drop any checker a previous file installed AND any state this one cached,
    // so the disk-backed default is what answers.
    setActivationChecker(null);
    _resetMigrationGuard();
    fetchCalls.spy.mockClear();
  });

  afterEach(() => {
    setActivationChecker(null);
    delete process.env.WIGOLO_DATA_DIR;
    if (savedPubkey === undefined) delete process.env.WIGOLO_ACCOUNTS_PUBKEY;
    else process.env.WIGOLO_ACCOUNTS_PUBKEY = savedPubkey;
    resetConfig();
    try { rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Write a real signed perpetual grant to the real state path — "register". */
  function registerOnDisk(): void {
    const { token } = mintToken(
      mintKeys,
      payload({
        account_id: 'acct_mid_flight',
        valid_until: '2099-01-01T00:00:00.000Z',
        grants: [grant({ product: 'core', type: 'perpetual' })],
      }),
    );
    const dir = join(tmpDataDir, 'account');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        account_id: 'acct_mid_flight',
        email: 'mid@example.invalid',
        entitlement_token: token,
        last_refresh_at: new Date().toISOString(),
        last_refresh_attempt_at: null,
        refresh_expires_at: null,
        needs_relogin: false,
        disclosure_version: null,
        marketing_consent: null,
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  it('serves the protocol unregistered: initialize and tools/list still work', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.listTools();
      expect(res.tools.length).toBeGreaterThanOrEqual(10);
      expect(res.tools.map((t) => t.name)).toContain('search');
    } finally {
      await teardown();
    }
  });

  it('dispatches a tool with no account at all, and returns the real result', async () => {
    // WHY: the single sentence §0a.1 turns on. PX2 answered this exact call with
    // `ACTIVATION_REFUSALS.never_activated` and `isError: true`.
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({
        name: 'diff',
        arguments: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
      });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(textOf(res)).changed).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('lets NO refusal line reach ANY of the ten tools unregistered', async () => {
    // WHY THE SWEEP RATHER THAN ONE CALL: a gate reintroduced on a single tool —
    // the shape of the regression this file exists to catch — is invisible to an
    // arm that only exercises `diff`. Every tool is called with arguments that
    // reach the handler, and the assertion is over the WHOLE result text, so a
    // refusal smuggled into a second content block would still red this.
    const args: Record<string, Record<string, unknown>> = {
      diff: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
      fetch: { url: 'https://example.invalid/x' },
      search: { query: 'anything' },
      crawl: { url: 'https://example.invalid/x', max_pages: 1 },
      cache: { stats: true },
      extract: { url: 'https://example.invalid/x', mode: 'metadata' },
      find_similar: { concept: 'anything' },
      research: { question: 'anything?', depth: 'quick' },
      agent: { prompt: 'anything', max_time_ms: 1 },
      watch: { action: 'list' },
    };
    const refusalLines = Object.values(ACTIVATION_REFUSALS);
    const { client, teardown } = await connectClient();
    try {
      for (const [name, argv] of Object.entries(args)) {
        const res = await client.callTool({ name, arguments: argv });
        const whole = JSON.stringify(res);
        for (const line of refusalLines) {
          expect(whole, `${name} rendered a refusal line`).not.toContain(line);
        }
      }
    } finally {
      await teardown();
    }
  });

  it('runs the overdue watch check unregistered — the path PX2 gated above', async () => {
    // WHY: the inverse of PX2's load-bearing arm. Its gate sat above
    // `scheduleOverdueCheck` precisely so an accountless install could not
    // egress; with no gate the scheduler is reachable, and this pins that the
    // fixture really is overdue so the zero in any future gate arm would mean
    // something.
    const { createJob, recordCheck, getJob } = await import('../../../src/watch/store.js');
    const { client, teardown } = await connectClient();
    try {
      const job = createJob({
        url: 'https://example.invalid/watched',
        intervalSeconds: 60,
        notification: 'inline',
      });
      recordCheck(job.id, Date.now() - 3_600_000, 'hash-before');
      const before = getJob(job.id)?.last_check_at ?? null;

      const res = await client.callTool({
        name: 'diff',
        arguments: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
      });
      await flushImmediates();
      expect(res.isError).toBeFalsy();
      expect(fetchCalls.spy).toHaveBeenCalled();
      expect(getJob(job.id)?.last_check_at).not.toBe(before);
    } finally {
      await teardown();
    }
  });

  it('keeps dispatching after an expired grant crosses its grace boundary', async () => {
    // WHY: PX2 flipped a LIVE server to refusing at exactly this boundary, with
    // no restart, and that arm was correct then. §0a.1 removed the wall from core
    // entirely — including the expired arm, which is the one people would most
    // expect to survive as a wall. The clock still moves; the behaviour does not.
    const lastRefresh = Date.parse('2026-01-01T00:00:00.000Z');
    const account = subscriptionAccount({
      validUntil: '2026-01-02T00:00:00.000Z',
      lastRefreshAt: new Date(lastRefresh).toISOString(),
    });
    const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
    let clock = lastRefresh + GRACE_MS - 1_000; // one second inside the window
    const restore = installChecker(sourceFor(account, () => clock));

    const { client, teardown } = await connectClient();
    try {
      const inside = await client.callTool({
        name: 'diff',
        arguments: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
      });
      expect(JSON.parse(textOf(inside)).changed).toBe(true);

      // Nothing about the process changes except the clock.
      clock = lastRefresh + GRACE_MS + 1_000;
      const outside = await client.callTool({
        name: 'diff',
        arguments: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
      });
      expect(outside.isError).toBeFalsy();
      expect(JSON.parse(textOf(outside)).changed).toBe(true);
      expect(JSON.stringify(outside)).not.toContain(ACTIVATION_REFUSALS.expired);
    } finally {
      await teardown();
      restore();
    }
  });

  // -------------------------------------------------------------------------
  // The single registration nudge (§0a.2)
  // -------------------------------------------------------------------------

  /** Every text block of a result, joined — the footer is never block zero. */
  function allText(res: unknown): string {
    const blocks = (res as { content?: Array<{ text?: string }> }).content ?? [];
    return blocks.map((b) => b.text ?? '').join('\n');
  }

  /** Block zero — every core tool's own JSON. The footer is never here. */
  function jsonBlockOf(res: unknown): string {
    return (res as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
  }

  // Typed as the real `Client` rather than a structural `{ callTool }`: the SDK's
  // signature is generic over the request schema, so a hand-written shape is not
  // assignable to it and every call site paid a type error for the convenience.
  async function callDiff(client: Client): Promise<unknown> {
    return client.callTool({
      name: 'diff',
      arguments: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
    });
  }

  async function runDiff(client: Client): Promise<string> {
    return allText(await callDiff(client));
  }

  it('fires the registration nudge EXACTLY once, on run N, and never again', async () => {
    // WHY THE WHOLE SEQUENCE IS DRIVEN: "never repeated" is the requirement, and
    // the two ways to get it wrong are opposite — a counter that resets (never
    // fires) and a flag that is never burned (fires forever). Neither is visible
    // from a single call, so the arm walks N-1 quiet runs, the one loud run, and
    // three more quiet ones.
    // THE BOUND IS DERIVED FROM THE CONSTANT, SO THE CONSTANT NEEDS ITS OWN PIN.
    // Every loop below counts to `NUDGE_AFTER_RUNS`, which means lowering it to 1
    // moves this whole arm with it and stays green. A nudge on the very first run
    // is a different product — an install prompt wearing a footer — so the first
    // run's silence is asserted against a LITERAL, and the band is asserted
    // directly. `< 2` is the regression; the upper bound catches a value nobody
    // reaches, which is the same nudge as no nudge.
    expect(NUDGE_AFTER_RUNS).toBeGreaterThanOrEqual(2);
    expect(NUDGE_AFTER_RUNS).toBeLessThanOrEqual(20);

    const { client, teardown } = await connectClient();
    try {
      expect(await runDiff(client), 'nudged on the first run').not.toContain(UNREGISTERED_RUNS_LINE);
      for (let i = 2; i < NUDGE_AFTER_RUNS; i += 1) {
        expect(await runDiff(client), `run ${i} nudged early`).not.toContain(UNREGISTERED_RUNS_LINE);
      }

      const onNResult = await callDiff(client);
      const onN = allText(onNResult);
      expect(onN).toContain(UNREGISTERED_RUNS_LINE);
      expect(onN).toContain('wigolo register');
      // The unlock LIST is the payload §0a.3 asks for, not just a sign-up line.
      for (const unlock of REGISTRATION_UNLOCKS) expect(onN).toContain(unlock);
      // Still a real result: the nudge rides ALONGSIDE the JSON, never into it.
      expect(JSON.parse(jsonBlockOf(onNResult)).changed).toBe(true);

      for (let i = 0; i < 3; i += 1) {
        expect(await runDiff(client), 'nudged twice').not.toContain(UNREGISTERED_RUNS_LINE);
      }
    } finally {
      await teardown();
    }
  });

  it('survives a restart: a new server does not re-nudge', async () => {
    // WHY: the flag has to be on disk. A per-process counter passes the arm above
    // and fails here — and a per-process counter is what an MCP install, whose
    // server the harness restarts every session, would hit every single session.
    const first = await connectClient();
    try {
      for (let i = 0; i < NUDGE_AFTER_RUNS; i += 1) await runDiff(first.client);
    } finally {
      await first.teardown();
    }
    expect(existsSync(nudgeStatePath(tmpDataDir))).toBe(true);

    setActivationChecker(null);
    const second = await connectClient();
    try {
      for (let i = 0; i < NUDGE_AFTER_RUNS + 1; i += 1) {
        expect(await runDiff(second.client)).not.toContain(UNREGISTERED_RUNS_LINE);
      }
    } finally {
      await second.teardown();
    }
  });

  it('never nudges a REGISTERED install, however many runs it makes', async () => {
    // WHY: the nudge's entire premise is "you have no account". Offering unlocks
    // to somebody who already bought them is the nag §0a.2 forbids.
    registerOnDisk();
    const { client, teardown } = await connectClient();
    try {
      for (let i = 0; i < NUDGE_AFTER_RUNS + 2; i += 1) {
        expect(await runDiff(client)).not.toContain(UNREGISTERED_RUNS_LINE);
      }
      // And nothing was even counted — no state file to carry into a later life.
      expect(existsSync(nudgeStatePath(tmpDataDir))).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('does not count FAILED calls toward the nudge', async () => {
    // WHY: §0a.2 says "after N SUCCESSFUL runs". A user whose calls all error has
    // not seen wigolo work, and a sign-up prompt under an error reads as part of
    // the error. `fetch` is stubbed to fail at the top of this file, so N failed
    // calls followed by N-1 good ones must stay quiet.
    const { client, teardown } = await connectClient();
    try {
      for (let i = 0; i < NUDGE_AFTER_RUNS + 1; i += 1) {
        const res = await client.callTool({
          name: 'fetch',
          arguments: { url: 'https://example.invalid/x' },
        });
        expect(res.isError).toBe(true);
        expect(allText(res)).not.toContain(UNREGISTERED_RUNS_LINE);
      }
      for (let i = 1; i < NUDGE_AFTER_RUNS; i += 1) {
        expect(await runDiff(client)).not.toContain(UNREGISTERED_RUNS_LINE);
      }
      // The very next successful run is N, and only now is it due.
      expect(await runDiff(client)).toContain(UNREGISTERED_RUNS_LINE);
    } finally {
      await teardown();
    }
  });
});

describe('the unlock notice in the per-session instructions', () => {
  it('prepends exactly one line when unregistered and nothing when registered', () => {
    expect(serverInstructions(true)).toBe(WIGOLO_INSTRUCTIONS);

    const unregistered = serverInstructions(false);
    expect(unregistered.startsWith(UNLOCK_NOTICE)).toBe(true);
    expect(unregistered).toContain(WIGOLO_INSTRUCTIONS);
    // One line, not a paragraph: the budget for this string is a session prompt.
    expect(UNLOCK_NOTICE.includes('\n')).toBe(false);
  });

  it('tells the model the tools WORK, and never to block a call on registering', () => {
    // WHY THIS ARM EXISTS AT ALL. The old notice said every tool call was refused
    // until registration — which was true then and is the exact failure mode now:
    // a model that reads "no account" and infers "so this will not work" stops
    // calling tools that work perfectly. The notice has to say the opposite
    // loudly enough that a model acts on it.
    expect(UNLOCK_NOTICE).toContain('work');
    expect(UNLOCK_NOTICE).toContain('optional');
    expect(UNLOCK_NOTICE).toContain('never block a tool call');
    expect(UNLOCK_NOTICE).toContain('wigolo register');
    // And it must not resurrect the old claim.
    expect(UNLOCK_NOTICE).not.toContain('refused');
  });
});
