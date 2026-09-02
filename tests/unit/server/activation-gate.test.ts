/**
 * The activation gate at MCP dispatch (PX2 mini-spec §3, issue #222).
 *
 * WHAT THESE ARMS ARE ACTUALLY ABOUT. It is easy to write a gate test that only
 * proves a string comes back. The properties that can actually break here are:
 *
 *   1. WHERE the gate sits. It is the first statement in the `tools/call`
 *      handler, ABOVE `scheduleOverdueCheck`. A gate one line lower would return
 *      the same refusal text and still re-fetch every overdue watch URL on
 *      behalf of an install with no account. So the egress arm below does not
 *      assert on the refusal at all — it asserts that the watch path did not
 *      run, and it proves the recorder can fire by running the same call
 *      activated and watching it fire.
 *   2. WHAT stays open. `initialize` and `tools/list` must keep working, or the
 *      server is a dead connection instead of a designed refusal.
 *   3. THAT IT RE-EVALUATES. Registering in another terminal has to take effect
 *      on the next call of a server that is already running, and a subscription
 *      crossing its grace boundary has to start refusing without a restart.
 *      Both are driven here — one by writing the real `state.json` mid-flight,
 *      the other by an injected clock.
 *
 * The data dir is repointed at an empty directory for the un-activated arms, so
 * "un-activated" is the real condition (no state file) rather than a stubbed
 * decision. The suite as a whole runs activated (see `tests/setup.ts`), which is
 * exactly why these arms have to build their own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetConfig } from '../../../src/config.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { ACTIVATION_REFUSALS } from '../../../src/account/gate.js';
import { setActivationChecker } from '../../../src/server/activation.js';
import { ACTIVATION_NOTICE, WIGOLO_INSTRUCTIONS, serverInstructions } from '../../../src/instructions.js';
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

const NEVER_ACTIVATED_LINE = ACTIVATION_REFUSALS.never_activated;

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

describe('activation gate — MCP tools/call', () => {
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

  it('serves the protocol unactivated: initialize and tools/list still work', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.listTools();
      // The full surface is still described — a harness must be able to see what
      // it would get, which is what makes the refusal legible rather than opaque.
      expect(res.tools.length).toBeGreaterThanOrEqual(10);
      expect(res.tools.map((t) => t.name)).toContain('search');
    } finally {
      await teardown();
    }
  });

  it('refuses tools/call with the pinned line as a designed tool error', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({
        name: 'diff',
        arguments: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
      });
      expect(textOf(res)).toBe(NEVER_ACTIVATED_LINE);
      expect(res.isError).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('refuses the hosted studio_* pass-through on the same seam', async () => {
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({ name: 'studio_list', arguments: {} });
      expect(textOf(res)).toBe(NEVER_ACTIVATED_LINE);
      expect(res.isError).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('a refused call produces ZERO watch-scheduler egress — and the recorder can fire', async () => {
    const { createJob, recordCheck, getJob } = await import('../../../src/watch/store.js');
    const { client, teardown } = await connectClient();
    try {
      // An overdue job: created, then stamped with a check an hour ago against a
      // 60-second interval. `scheduleOverdueCheck` would re-fetch it.
      const job = createJob({
        url: 'https://example.invalid/watched',
        intervalSeconds: 60,
        notification: 'inline',
      });
      recordCheck(job.id, Date.now() - 3_600_000, 'hash-before');
      const before = getJob(job.id)?.last_check_at ?? null;

      // ARM 1 — un-activated. The refusal must arrive with the watch path untouched.
      const refused = await client.callTool({
        name: 'diff',
        arguments: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
      });
      await flushImmediates();
      expect(textOf(refused)).toBe(NEVER_ACTIVATED_LINE);
      expect(fetchCalls.spy).not.toHaveBeenCalled();
      expect(getJob(job.id)?.last_check_at).toBe(before);

      // ARM 2 — the same call, activated. This is the outside signal: it proves
      // the job really is overdue and the recorder really does fire, so ARM 1's
      // zero is a fact about the gate and not about a mis-built fixture.
      registerOnDisk();
      const allowed = await client.callTool({
        name: 'diff',
        arguments: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
      });
      await flushImmediates();
      expect(textOf(allowed)).not.toBe(NEVER_ACTIVATED_LINE);
      expect(fetchCalls.spy).toHaveBeenCalled();
      expect(getJob(job.id)?.last_check_at).not.toBe(before);
    } finally {
      await teardown();
    }
  });

  it('registering mid-flight makes the very next call succeed — no server restart', async () => {
    const { client, teardown } = await connectClient();
    try {
      const first = await client.callTool({
        name: 'diff',
        arguments: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
      });
      expect(textOf(first)).toBe(NEVER_ACTIVATED_LINE);

      registerOnDisk();

      // Same client, same server, same session. If the refusal were cached for
      // the ≤1/min reload window this would still be the refusal line.
      const second = await client.callTool({
        name: 'diff',
        arguments: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
      });
      expect(textOf(second)).not.toBe(NEVER_ACTIVATED_LINE);
      expect(JSON.parse(textOf(second)).changed).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('crossing the grace boundary mid-flight flips a live server to refusing', async () => {
    // A subscription grant: no perpetual arm, so `valid_until` and the 14-day
    // rolling grace are what decide — the only shape whose activation expires.
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
      expect(textOf(inside)).not.toBe(ACTIVATION_REFUSALS.expired);

      // Nothing about the process changes except the clock.
      clock = lastRefresh + GRACE_MS + 1_000;
      const outside = await client.callTool({
        name: 'diff',
        arguments: { old: { markdown: 'a\n' }, new: { markdown: 'b\n' }, output: 'unified' },
      });
      expect(textOf(outside)).toBe(ACTIVATION_REFUSALS.expired);
      expect(outside.isError).toBe(true);
    } finally {
      await teardown();
      restore();
    }
  });
});

describe('activation notice in the per-session instructions', () => {
  it('prepends exactly one line when un-activated and nothing when activated', () => {
    expect(serverInstructions(true)).toBe(WIGOLO_INSTRUCTIONS);

    const unactivated = serverInstructions(false);
    expect(unactivated.startsWith(ACTIVATION_NOTICE)).toBe(true);
    expect(unactivated).toContain(WIGOLO_INSTRUCTIONS);
    // One line, not a paragraph: the budget for this string is a session prompt.
    expect(ACTIVATION_NOTICE.includes('\n')).toBe(false);
  });

  it('names `wigolo register` and says a restart is not needed', () => {
    // The honest limitation the mini-spec pins: the notice is composed once at
    // construction, so it can outlive the state it describes. It is only
    // harmless because it tells the reader that retrying is enough.
    expect(ACTIVATION_NOTICE).toContain('wigolo register');
    expect(ACTIVATION_NOTICE).toContain('no restart');
  });
});
