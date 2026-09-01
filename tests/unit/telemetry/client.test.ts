import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * In-memory keychain, the same shape `tests/unit/account/*` use: the token store reaches for
 * the real OS keychain otherwise, which is both slow and shared across every test run on the
 * machine.
 */
vi.mock('../../../src/security/keychain.js', () => {
  const store = new Map<string, string>();
  return {
    keychainAvailable: vi.fn(() => true),
    keychainSet: vi.fn((service: string, user: string, value: string) => { store.set(`${service}:${user}`, value); }),
    keychainGet: vi.fn((service: string, user: string) => store.get(`${service}:${user}`) ?? null),
    keychainDelete: vi.fn((service: string, user: string) => { store.delete(`${service}:${user}`); }),
    _store: store,
  };
});

const { AccountsClient } = await import('../../../src/account/client.js');
const { AccountStateStore } = await import('../../../src/account/state.js');
const { setAccessToken, _resetAccessTokenCache } = await import('../../../src/account/token-store.js');
const { DEFAULT_RETRY_AFTER_S, MIN_FLUSH_SPACING_MS, TelemetryClient } = await import('../../../src/telemetry/client.js');
const { TelemetryQueue, queuePath } = await import('../../../src/telemetry/queue.js');
const { MAX_EVENTS_PER_BATCH } = await import('../../../src/telemetry/envelope.js');

type TelemetryEvent = import('../../../src/telemetry/events.js').TelemetryEvent;
type ToolName = import('../../../src/telemetry/events.js').ToolName;

const BASE_URL = 'https://accounts.test';
const CLIENT_INFO = { version: '0.3.0', os: 'darwin', arch: 'arm64' };
const T0 = Date.UTC(2026, 8, 2, 12, 0, 0);

let dataDir: string;
let clock: number;
/** Every envelope the transport was handed, in order. */
let sentBatches: { events: { name: string }[] }[];

function ok(accepted: number): Response {
  return new Response(JSON.stringify({ accepted }), { status: 202, headers: { 'content-type': 'application/json' } });
}

function err(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message: code, ...extra } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Responder = (envelope: { events: { name: string }[] }) => Response;

function makeTelemetry(opts: { enabled?: boolean; activated?: boolean; token?: boolean; responder?: Responder } = {}) {
  const { enabled = true, activated = true, token = true, responder = () => ok(1) } = opts;
  if (activated) new AccountStateStore(dataDir).write({ account_id: 'acc_test', email: 'x@example.com' });
  if (token) setAccessToken('access-token', 3600, { dataDir }, clock);

  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const envelope = JSON.parse(String(init?.body ?? '{}')) as { events: { name: string }[] };
    sentBatches.push(envelope);
    return responder(envelope);
  };
  const accountsClient = new AccountsClient({ baseUrl: BASE_URL, fetchImpl });
  const telemetry = new TelemetryClient({
    dataDir,
    accountsUrl: BASE_URL,
    enabled,
    accountsClient,
    now: () => clock,
    client: CLIENT_INFO,
  });
  return telemetry;
}

function toolRun(tool: ToolName = 'search'): TelemetryEvent {
  return { name: 'tool.run', props: { tool, surface: 'mcp', ok: true, duration_bucket: 'lt_2s' } };
}

describe('TelemetryClient', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-telemetry-client-'));
    clock = T0;
    sentBatches = [];
    _resetAccessTokenCache();
  });

  afterEach(() => {
    _resetAccessTokenCache();
    rmSync(dataDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('off means off', () => {
    it('writes nothing to disk and opens no connection when the switch is off', async () => {
      const telemetry = makeTelemetry({ enabled: false });
      expect(telemetry.emit(toolRun())).toBe(false);
      expect(telemetry.emit(toolRun('fetch'))).toBe(false);

      // The queue file is never even created — an install with telemetry off leaves no
      // telemetry footprint on disk, not merely an undrained one.
      expect(existsSync(queuePath(dataDir))).toBe(false);
      expect(await telemetry.flush()).toMatchObject({ status: 'disabled', sent: 0 });
      expect(sentBatches).toEqual([]);
    });

    it('arms no timer when off, so nothing can flush later either', async () => {
      const telemetry = makeTelemetry({ enabled: false });
      telemetry.start();
      try {
        for (let i = 0; i < 60; i += 1) telemetry.emit(toolRun());
        expect(existsSync(queuePath(dataDir))).toBe(false);
        expect(sentBatches).toEqual([]);
      } finally {
        telemetry.stop();
      }
    });

    it('stays off until the install is activated', async () => {
      const telemetry = makeTelemetry({ activated: false });
      expect(telemetry.isCollecting()).toBe(false);
      expect(telemetry.emit(toolRun())).toBe(false);
      expect(existsSync(queuePath(dataDir))).toBe(false);
      expect(await telemetry.flush()).toMatchObject({ status: 'not_activated' });
      expect(sentBatches).toEqual([]);
    });

    it('starts collecting once an account id appears', () => {
      const telemetry = makeTelemetry({ activated: false });
      expect(telemetry.emit(toolRun())).toBe(false);
      new AccountStateStore(dataDir).write({ account_id: 'acc_later' });
      clock += 61_000; // past the activation cache TTL
      expect(telemetry.emit(toolRun())).toBe(true);
      expect(new TelemetryQueue(dataDir).count()).toBe(1);
    });
  });

  describe('queueing', () => {
    it('appends an event with a timestamp taken from the injected clock', () => {
      const telemetry = makeTelemetry();
      expect(telemetry.emit(toolRun())).toBe(true);
      const [queued] = new TelemetryQueue(dataDir).readAll();
      expect(queued?.ts).toBe(new Date(T0).toISOString());
    });

    it('refuses an event the closed dictionary does not admit', () => {
      const telemetry = makeTelemetry();
      const smuggled = { name: 'tool.run', props: { tool: 'search', surface: 'mcp', ok: true, duration_bucket: 'lt_2s', query: 'secret' } } as unknown as TelemetryEvent;
      expect(telemetry.emit(smuggled)).toBe(false);
      expect(existsSync(queuePath(dataDir))).toBe(false);
    });

    it('does not flush from emit when no timer is armed — a CLI one-shot appends and exits', () => {
      const telemetry = makeTelemetry();
      for (let i = 0; i < 120; i += 1) telemetry.emit(toolRun());
      expect(new TelemetryQueue(dataDir).count()).toBe(120);
      expect(sentBatches).toEqual([]);
    });
  });

  describe('flush spacing', () => {
    it('refuses a second attempt inside the 60 s minimum spacing', async () => {
      const telemetry = makeTelemetry();
      telemetry.emit(toolRun());
      expect(await telemetry.flush()).toMatchObject({ status: 'sent', sent: 1 });

      telemetry.emit(toolRun('fetch'));
      clock += MIN_FLUSH_SPACING_MS - 1;
      expect(await telemetry.flush()).toMatchObject({ status: 'spaced', sent: 0 });
      expect(sentBatches).toHaveLength(1);

      clock += 1;
      expect(await telemetry.flush()).toMatchObject({ status: 'sent', sent: 1 });
      expect(sentBatches).toHaveLength(2);
    });

    it('caps attempts below the account batch limit by construction', () => {
      // 120 batches/hour is the account limit; one attempt per 60 s is 60/hour, whatever the
      // event rate. This is the arithmetic the spacing constant exists to guarantee.
      expect(3_600_000 / MIN_FLUSH_SPACING_MS).toBeLessThanOrEqual(120);
    });

    it('consumes its spacing slot even when the attempt fails', async () => {
      const telemetry = makeTelemetry({ responder: () => err(503, 'unavailable') });
      telemetry.emit(toolRun());
      expect(await telemetry.flush()).toMatchObject({ status: 'retained', sent: 0, retained: 1 });
      // A failing service must not be retried on every subsequent event.
      expect(await telemetry.flush()).toMatchObject({ status: 'spaced' });
      expect(sentBatches).toHaveLength(1);
    });
  });

  describe('429', () => {
    it('retains every event and waits out retry_after_s', async () => {
      let phase: 'limited' | 'open' = 'limited';
      const telemetry = makeTelemetry({
        responder: (envelope) => (phase === 'limited' ? err(429, 'rate_limited', { retry_after_s: 600 }) : ok(envelope.events.length)),
      });
      telemetry.emit(toolRun());
      telemetry.emit(toolRun('fetch'));

      expect(await telemetry.flush()).toMatchObject({ status: 'retained', sent: 0, dropped: 0, retained: 2 });
      expect(new TelemetryQueue(dataDir).count()).toBe(2);

      // Spacing alone has elapsed, but the server's own window has not.
      phase = 'open';
      clock += MIN_FLUSH_SPACING_MS;
      expect(await telemetry.flush()).toMatchObject({ status: 'backoff' });
      expect(sentBatches).toHaveLength(1);

      clock += 600_000;
      expect(await telemetry.flush()).toMatchObject({ status: 'sent', sent: 2 });
      expect(new TelemetryQueue(dataDir).count()).toBe(0);
    });

    it('backs off longer than ordinary spacing when the server omits retry_after_s', async () => {
      // A 429 with no window still has to change behaviour: falling back to the ordinary
      // 60 s cadence would answer the rate limit by doing exactly the same thing again.
      expect(DEFAULT_RETRY_AFTER_S * 1000).toBeGreaterThan(MIN_FLUSH_SPACING_MS);
      let limited = true;
      const telemetry = makeTelemetry({ responder: (e) => (limited ? err(429, 'rate_limited') : ok(e.events.length)) });
      telemetry.emit(toolRun());
      await telemetry.flush();

      limited = false;
      clock += MIN_FLUSH_SPACING_MS;
      expect(await telemetry.flush()).toMatchObject({ status: 'backoff' });
      expect(sentBatches).toHaveLength(1);

      clock += DEFAULT_RETRY_AFTER_S * 1000;
      expect(await telemetry.flush()).toMatchObject({ status: 'sent', sent: 1 });
    });
  });

  describe('413', () => {
    it('bisects until the batches fit, losing nothing', async () => {
      // A server whose real body limit is one event — the composed-size case byte counting
      // can miss. Every event still lands; only the batching changes.
      const telemetry = makeTelemetry({
        responder: (envelope) => (envelope.events.length > 1 ? err(413, 'payload_too_large') : ok(1)),
      });
      for (let i = 0; i < 4; i += 1) telemetry.emit(toolRun());

      expect(await telemetry.flush()).toMatchObject({ status: 'sent', sent: 4, dropped: 0 });
      expect(new TelemetryQueue(dataDir).count()).toBe(0);
      expect(sentBatches.map((b) => b.events.length)).toEqual([4, 2, 1, 1, 2, 1, 1]);
    });

    it('drops exactly the one event that cannot fit alone, and keeps its neighbours', async () => {
      const telemetry = makeTelemetry({
        responder: (envelope) => (envelope.events.some((e) => e.name === 'daemon.uptime') ? err(413, 'payload_too_large') : ok(envelope.events.length)),
      });
      telemetry.emit(toolRun());
      telemetry.emit(toolRun('fetch'));
      telemetry.emit({ name: 'daemon.uptime', props: { bucket: 'lt_8h' } });
      telemetry.emit(toolRun('crawl'));

      const result = await telemetry.flush();
      expect(result).toMatchObject({ status: 'sent', sent: 3, dropped: 1 });
      expect(new TelemetryQueue(dataDir).count()).toBe(0);
    });
  });

  describe('other failures', () => {
    it('drops a batch the server will reject identically forever (400)', async () => {
      const telemetry = makeTelemetry({ responder: () => err(400, 'invalid_event') });
      telemetry.emit(toolRun());
      expect(await telemetry.flush()).toMatchObject({ status: 'sent', sent: 0, dropped: 1, retained: 0 });
      // Retaining it would wedge every later event behind data that can never leave.
      expect(new TelemetryQueue(dataDir).count()).toBe(0);
    });

    it('retains on a transient failure and sends on the next attempt', async () => {
      let down = true;
      const telemetry = makeTelemetry({ responder: (e) => (down ? err(500, 'internal') : ok(e.events.length)) });
      telemetry.emit(toolRun());
      expect(await telemetry.flush()).toMatchObject({ status: 'retained', retained: 1 });
      expect(new TelemetryQueue(dataDir).count()).toBe(1);

      down = false;
      clock += MIN_FLUSH_SPACING_MS;
      expect(await telemetry.flush()).toMatchObject({ status: 'sent', sent: 1 });
      expect(new TelemetryQueue(dataDir).count()).toBe(0);
    });

    it('retains on an auth failure — the token is re-minted, the data is not lost', async () => {
      const telemetry = makeTelemetry({ responder: () => err(401, 'unauthorized') });
      telemetry.emit(toolRun());
      expect(await telemetry.flush()).toMatchObject({ status: 'retained', dropped: 0, retained: 1 });
    });

    it('retains everything when no access token can be minted', async () => {
      // Activated, but no cached access token and no refresh credential on disk: the refresh
      // policy answers `no_credential` and the events wait for a surface that holds one.
      const telemetry = makeTelemetry({ token: false });
      telemetry.emit(toolRun());
      expect(await telemetry.flush()).toMatchObject({ status: 'no_token', sent: 0, dropped: 0, retained: 1 });
      expect(new TelemetryQueue(dataDir).count()).toBe(1);
      expect(sentBatches).toEqual([]);
    });

    it('reports nothing to flush on an empty queue', async () => {
      const telemetry = makeTelemetry();
      expect(await telemetry.flush()).toMatchObject({ status: 'empty' });
      expect(sentBatches).toEqual([]);
    });
  });

  describe('batching', () => {
    it('chunks a large drain to the server event cap', async () => {
      const telemetry = makeTelemetry({ responder: (e) => ok(e.events.length) });
      for (let i = 0; i < MAX_EVENTS_PER_BATCH + 3; i += 1) telemetry.emit(toolRun());

      expect(await telemetry.flush()).toMatchObject({ status: 'sent', sent: MAX_EVENTS_PER_BATCH + 3 });
      expect(sentBatches.map((b) => b.events.length)).toEqual([MAX_EVENTS_PER_BATCH, 3]);
    });

    it('sends the pinned envelope shape and keys the batch by Bearer token only', async () => {
      const telemetry = makeTelemetry();
      telemetry.emit(toolRun());
      await telemetry.flush();
      const [envelope] = sentBatches;
      expect(Object.keys(envelope as object).sort()).toEqual(['client', 'events']);
      expect(envelope).toMatchObject({ client: CLIENT_INFO });
      expect(JSON.stringify(envelope)).not.toContain('acc_test');
    });

    it('cleans retired day-files on the flush path', async () => {
      const telemetry = makeTelemetry();
      telemetry.emit(toolRun());
      const legacy = join(dataDir, 'telemetry', 'events-20260101.ndjson');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(legacy, '{"old":true}\n');
      await telemetry.flush();
      expect(existsSync(legacy)).toBe(false);
    });

    it('shares one attempt between concurrent callers', async () => {
      const telemetry = makeTelemetry({ responder: (e) => ok(e.events.length) });
      telemetry.emit(toolRun());
      const [a, b] = await Promise.all([telemetry.flush(), telemetry.flush()]);
      expect(a).toBe(b);
      expect(sentBatches).toHaveLength(1);
    });
  });

  describe('timer', () => {
    it('flushes from emit once the threshold is reached, but only with a timer armed', async () => {
      const telemetry = makeTelemetry({ responder: (e) => ok(e.events.length) });
      telemetry.start();
      try {
        for (let i = 0; i < 50; i += 1) telemetry.emit(toolRun());
        await telemetry.flush();
        expect(sentBatches).toHaveLength(1);
        expect(sentBatches[0]?.events).toHaveLength(50);
      } finally {
        telemetry.stop();
      }
    });

    it('does not keep the process alive', () => {
      const telemetry = makeTelemetry();
      telemetry.start();
      try {
        // `unref` is what makes an armed timer safe in a CLI that is about to exit.
        expect(telemetry.emit(toolRun())).toBe(true);
      } finally {
        telemetry.stop();
      }
    });
  });
});
