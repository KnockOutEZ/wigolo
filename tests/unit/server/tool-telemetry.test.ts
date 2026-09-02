/**
 * `tool.run` / `tool.error` at the MCP dispatch seam, and the property the gate makes true.
 *
 * WHAT THE REFUSAL ARMS ARE ABOUT. "Refused calls emit nothing" is not a flag anyone
 * passes — it is a consequence of the gate being an early return ABOVE the audit block. A
 * report moved above it would keep every other arm here green while shipping tool counts
 * for installs that have no entitlement.
 *
 * There are TWO refusal arms because one of them cannot see that break on its own. The
 * never-activated arm is the obvious one, and it is measurably too weak: the telemetry
 * client independently declines to collect without an account id, so a report placed above
 * the gate writes nothing there anyway and the arm stays green. The mutation was run.
 *
 * The EXPIRED arm is what actually pins the placement. Its `state.json` carries a real
 * account id, so the client is collecting; the gate refuses regardless, because the token
 * is out of validity and out of grace. That is the one state where the two layers
 * disagree, and it goes red the moment the report moves.
 *
 * Both conditions are real — an empty data dir for the first, a minted past-dated
 * subscription for the second — not stubbed decisions. The suite's default install is
 * activated, which is exactly why these arms have to build their own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetConfig } from '../../../src/config.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { setActivationChecker } from '../../../src/server/activation.js';
import { ACTIVATION_REFUSALS } from '../../../src/account/gate.js';
import { queuePath } from '../../../src/telemetry/queue.js';
import { _resetTelemetryForTest, telemetryStatus } from '../../../src/telemetry/index.js';
import { generateMintKeyPair, mintToken, grant, payload } from '../account/mint-entitlement.js';
import { mkdirSync, writeFileSync } from 'node:fs';

vi.mock('../../../src/cache/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cache/db.js')>('../../../src/cache/db.js');
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
  getEmbeddingService: () => ({ init: vi.fn().mockResolvedValue(undefined), isAvailable: () => false, shutdown: vi.fn() }),
  resetEmbeddingService: vi.fn(),
}));

/**
 * The tool under test, stubbed so the arm chooses success or failure. `fetch` is used
 * because it is the tool whose failures actually carry an interesting class.
 */
const fetchStub = vi.hoisted(() => ({ impl: vi.fn() }));
vi.mock('../../../src/tools/fetch.js', () => ({
  handleFetch: (...args: unknown[]) => fetchStub.impl(...args),
}));

/** A URL and a query planted so their absence from the queue is provable by byte search. */
const PLANTED_URL = 'https://docs.internal.example.org/secret/zqxjkvw-plan?token=hunter2';

/** First text block of a CallToolResult. `unknown` because the SDK's result type carries
 *  an index signature the narrower shape cannot absorb. */
function textOf(res: unknown): string {
  const blocks = (res as { content?: Array<{ text?: string }> }).content;
  return blocks?.[0]?.text ?? '';
}

async function connectClient() {
  const { initSubsystems, createMcpServer } = await import('../../../src/server.js');
  const subs = await initSubsystems();
  const server = createMcpServer(subs);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    teardown: async () => {
      await client.close();
      await server.close();
      await subs.shutdown();
    },
  };
}

describe('tool.run / tool.error at the MCP dispatch seam', () => {
  let dataDir: string;
  let savedPubkey: string | undefined;
  let savedTelemetryEnv: string | undefined;
  const mintKeys = generateMintKeyPair();

  function activate(): void {
    const { token } = mintToken(
      mintKeys,
      payload({
        account_id: 'acct_tool_telemetry',
        valid_until: '2099-01-01T00:00:00.000Z',
        grants: [grant({ product: 'core', type: 'perpetual' })],
      }),
    );
    const dir = join(dataDir, 'account');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        account_id: 'acct_tool_telemetry',
        email: 'tool@example.invalid',
        entitlement_token: token,
        last_refresh_at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  }

  function queueBytes(): string {
    const path = queuePath(dataDir);
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  }

  function queuedEvents(): { name: string; props: Record<string, unknown> }[] {
    return queueBytes()
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { name: string; props: Record<string, unknown> });
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-tool-telemetry-'));
    process.env.WIGOLO_DATA_DIR = dataDir;
    savedPubkey = process.env.WIGOLO_ACCOUNTS_PUBKEY;
    process.env.WIGOLO_ACCOUNTS_PUBKEY = mintKeys.publicKeyB64Url;
    savedTelemetryEnv = process.env.WIGOLO_TELEMETRY;
    // Forced ON rather than deleted: leaving it unset makes the switch depend on the
    // ambient absence of a persisted setting, and a byte search over a queue that was
    // silent for that reason passes vacuously. Measured — a settings file with
    // `telemetryEnabled: false` produced exactly that empty-queue false pass.
    process.env.WIGOLO_TELEMETRY = 'on';
    resetConfig();
    setActivationChecker(null);
    _resetMigrationGuard();
    _resetTelemetryForTest();
    fetchStub.impl.mockReset();
  });

  afterEach(() => {
    setActivationChecker(null);
    _resetTelemetryForTest();
    delete process.env.WIGOLO_DATA_DIR;
    if (savedPubkey === undefined) delete process.env.WIGOLO_ACCOUNTS_PUBKEY;
    else process.env.WIGOLO_ACCOUNTS_PUBKEY = savedPubkey;
    if (savedTelemetryEnv === undefined) delete process.env.WIGOLO_TELEMETRY;
    else process.env.WIGOLO_TELEMETRY = savedTelemetryEnv;
    resetConfig();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reports a successful call as tool.run with a bucket, and nothing else', async () => {
    activate();
    fetchStub.impl.mockResolvedValue({ ok: true, data: { url: PLANTED_URL, markdown: 'body text' } });
    const { client, teardown } = await connectClient();
    try {
      await client.callTool({ name: 'fetch', arguments: { url: PLANTED_URL } });
    } finally {
      await teardown();
    }

    const events = queuedEvents();
    expect(events.map((e) => e.name)).toEqual(['tool.run']);
    expect(events[0].props.tool).toBe('fetch');
    expect(events[0].props.surface).toBe('mcp');
    expect(events[0].props.ok).toBe(true);
    expect(events[0].props.duration_bucket).toMatch(/^(lt_100ms|lt_500ms|lt_2s|lt_10s|lt_60s|ge_60s)$/);
  });

  it('reports a failed call as BOTH tool.run(ok:false) and tool.error with a class', async () => {
    activate();
    fetchStub.impl.mockResolvedValue({
      ok: false,
      error: 'blocked_by_challenge',
      error_reason: `the site at ${PLANTED_URL} served an interstitial`,
      stage: 'fetch',
    });
    const { client, teardown } = await connectClient();
    try {
      await client.callTool({ name: 'fetch', arguments: { url: PLANTED_URL } });
    } finally {
      await teardown();
    }

    const events = queuedEvents();
    // Both, not just the error: emitting only the error would make the run counter and
    // the error counter disagree about how many calls happened.
    expect(events.map((e) => e.name)).toEqual(['tool.run', 'tool.error']);
    expect(events[0].props).toMatchObject({ tool: 'fetch', surface: 'mcp', ok: false });
    expect(events[1].props).toMatchObject({ tool: 'fetch', surface: 'mcp', error_class: 'blocked' });
  });

  it('keeps the URL out of the emitted bytes even when the failure prose quotes it', async () => {
    activate();
    fetchStub.impl.mockResolvedValue({
      ok: false,
      error: 'timeout',
      error_reason: `timed out fetching ${PLANTED_URL}`,
      stage: 'fetch',
    });
    const { client, teardown } = await connectClient();
    try {
      await client.callTool({ name: 'fetch', arguments: { url: PLANTED_URL } });
    } finally {
      await teardown();
    }

    const bytes = queueBytes();
    // The search is worthless over an empty queue — pin that events were actually written.
    expect(queuedEvents().map((e) => e.name)).toEqual(['tool.run', 'tool.error']);
    expect(bytes).not.toContain(PLANTED_URL);
    expect(bytes).not.toContain('zqxjkvw-plan');
    expect(bytes).not.toContain('hunter2');
    expect(bytes).not.toContain('docs.internal');
    expect(bytes).not.toContain('/secret/');
  });

  it('emits ZERO events for a never-activated call', async () => {
    // No activate(): the data dir has no state file, so the gate refuses for real.
    fetchStub.impl.mockResolvedValue({ ok: true, data: { url: PLANTED_URL, markdown: 'x' } });
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({ name: 'fetch', arguments: { url: PLANTED_URL } });
      expect(res.isError).toBe(true);
    } finally {
      await teardown();
    }

    // No queue file at all — not an empty one, not one with a refusal event.
    expect(existsSync(queuePath(dataDir))).toBe(false);

    // And the recorder is not simply broken in this file: the SAME call, on the SAME
    // process, reports as soon as the install is activated.
    activate();
    _resetTelemetryForTest();
    const second = await connectClient();
    try {
      await second.client.callTool({ name: 'fetch', arguments: { url: PLANTED_URL } });
    } finally {
      await second.teardown();
    }
    expect(queuedEvents().map((e) => e.name)).toContain('tool.run');
  });

  /**
   * THE ARM THAT PINS THE GATE'S PLACEMENT.
   *
   * The never-activated arm above cannot do it: the telemetry client independently
   * declines to collect when there is no account id, so a report moved ABOVE the gate
   * would still write nothing there and that arm would stay green. Measured — the
   * mutation was run.
   *
   * An EXPIRED install is the shape that separates the two layers. Its `state.json`
   * carries a real `account_id`, so the client is collecting; the gate refuses anyway,
   * because the token is out of validity and out of its 14-day grace. If the report ever
   * moves above the refusal, this queue stops being empty.
   *
   * The condition is forced, not stubbed: a real subscription token is minted with a past
   * `valid_until` and a `last_refresh_at` aged past the grace window, and the gate walks
   * all six of its steps over it.
   */
  it('emits ZERO events for an EXPIRED install, whose account id would otherwise be collecting', async () => {
    const past = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    const { token } = mintToken(
      mintKeys,
      payload({
        account_id: 'acct_expired',
        valid_until: past,
        grants: [grant({ product: 'core', type: 'subscription', expires: past })],
      }),
    );
    const dir = join(dataDir, 'account');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        account_id: 'acct_expired',
        email: 'expired@example.invalid',
        entitlement_token: token,
        // 30 days ago — well past ACTIVATION_GRACE_MS.
        last_refresh_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
      }),
      { mode: 0o600 },
    );

    // The precondition this arm rests on: telemetry considers this install activated.
    expect(telemetryStatus()).toBe('enabled');

    fetchStub.impl.mockResolvedValue({ ok: true, data: { url: PLANTED_URL, markdown: 'x' } });
    const { client, teardown } = await connectClient();
    try {
      const res = await client.callTool({ name: 'fetch', arguments: { url: PLANTED_URL } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(ACTIVATION_REFUSALS.expired);
    } finally {
      await teardown();
    }

    expect(queueBytes()).toBe('');
  });

  it('reports nothing for a name outside the ten-tool enum', async () => {
    activate();
    const { client, teardown } = await connectClient();
    try {
      await client.callTool({ name: 'not_a_wigolo_tool', arguments: {} }).catch(() => undefined);
    } finally {
      await teardown();
    }

    expect(queuedEvents().filter((e) => e.name.startsWith('tool.'))).toHaveLength(0);
  });
});
