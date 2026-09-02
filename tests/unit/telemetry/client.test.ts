import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
const { setAccessToken, storeRefreshToken, _resetAccessTokenCache } = await import('../../../src/account/token-store.js');
const {
  DEFAULT_RETRY_AFTER_S,
  FLUSH_EVENT_THRESHOLD,
  FLUSH_INTERVAL_MS,
  MIN_BATCH_SPACING_MS,
  MIN_FLUSH_SPACING_MS,
  TelemetryClient,
} = await import('../../../src/telemetry/client.js');
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

type Responder = (envelope: { events: { name: string }[] }) => Response | Promise<Response>;

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
    sleep: async (ms) => { clock += ms; },
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
    vi.useRealTimers();
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
      telemetry.start();
      expect(telemetry.emit(toolRun())).toBe(false);
      new AccountStateStore(dataDir).write({ account_id: 'acc_later' });
      clock += 61_000; // past the activation cache TTL
      expect(telemetry.emit(toolRun())).toBe(true);
      expect(new TelemetryQueue(dataDir).count()).toBe(1);
      expect(telemetry.timerForTest).not.toBeNull();
      telemetry.stop();
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

    it('shares the durable spacing slot across client instances and restarts', async () => {
      const first = makeTelemetry();
      first.emit(toolRun());
      expect(await first.flush()).toMatchObject({ status: 'sent' });

      const restarted = makeTelemetry();
      restarted.emit(toolRun('fetch'));
      expect(await restarted.flush()).toMatchObject({ status: 'spaced', sent: 0 });
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

    it('keeps retry_after_s across a new client instance', async () => {
      const limited = makeTelemetry({ responder: () => err(429, 'rate_limited', { retry_after_s: 600 }) });
      limited.emit(toolRun());
      await limited.flush();

      clock += MIN_FLUSH_SPACING_MS;
      const restarted = makeTelemetry({ responder: (e) => ok(e.events.length) });
      expect(await restarted.flush()).toMatchObject({ status: 'backoff', sent: 0 });
      expect(sentBatches).toHaveLength(1);
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

    it('retains a malformed 400 because it is not a terminal service verdict', async () => {
      const telemetry = makeTelemetry({ responder: () => new Response('proxy rejected request', { status: 400 }) });
      telemetry.emit(toolRun());

      expect(await telemetry.flush()).toMatchObject({ status: 'retained', sent: 0, dropped: 0, retained: 1 });
      expect(new TelemetryQueue(dataDir).count()).toBe(1);
    });

    it('retains a batch when a success response does not acknowledge every event', async () => {
      const telemetry = makeTelemetry({ responder: () => ok(0) });
      telemetry.emit(toolRun());

      expect(await telemetry.flush()).toMatchObject({ status: 'retained', sent: 0, dropped: 0, retained: 1 });
      expect(new TelemetryQueue(dataDir).count()).toBe(1);
    });

    it('skips network when durable delivery-state pacing cannot be persisted', async () => {
      const telemetry = makeTelemetry();
      telemetry.emit(toolRun());
      mkdirSync(join(dataDir, 'telemetry', 'delivery-state.json'));

      expect(await telemetry.flush()).toMatchObject({ status: 'retained', sent: 0, dropped: 0, retained: 1 });
      expect(sentBatches).toEqual([]);
      expect(new TelemetryQueue(dataDir).count()).toBe(1);
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

    it('never rejects even when an internal dependency violates its never-throw contract', async () => {
      const accounts = new AccountsClient({ baseUrl: BASE_URL });
      accounts.telemetryBatch = async () => { throw new Error('broken injected client'); };
      new AccountStateStore(dataDir).write({ account_id: 'acc_test' });
      setAccessToken('access-token', 3600, { dataDir }, clock);
      const telemetry = new TelemetryClient({
        dataDir,
        accountsUrl: BASE_URL,
        enabled: true,
        accountsClient: accounts,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        client: CLIENT_INFO,
      });
      telemetry.emit(toolRun());

      await expect(telemetry.flush()).resolves.toMatchObject({ status: 'retained', sent: 0 });
      expect(new TelemetryQueue(dataDir).count()).toBe(1);
    });

    it('respects the automatic refresh throttle when the memory-only access token is stale', async () => {
      new AccountStateStore(dataDir).write({
        account_id: 'acc_test',
        email: 'x@example.com',
        last_refresh_attempt_at: new Date(clock).toISOString(),
      });
      await storeRefreshToken('refresh-token', { dataDir });
      const paths: string[] = [];
      const accounts = new AccountsClient({
        baseUrl: BASE_URL,
        fetchImpl: async (url, init) => {
          const path = new URL(url).pathname;
          paths.push(path);
          if (path === '/auth/refresh') {
            return new Response(JSON.stringify({
              access_token: 'fresh-access',
              access_expires_in_s: 900,
              refresh_token: 'rotated-refresh',
              refresh_expires_at: '2026-12-01T00:00:00.000Z',
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          if (path === '/entitlements/token') {
            return new Response(JSON.stringify({ token: 'ent', valid_until: '2026-12-01T00:00:00.000Z', kid: 'k1' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer fresh-access');
          return ok(1);
        },
      });
      const telemetry = new TelemetryClient({
        dataDir,
        accountsUrl: BASE_URL,
        enabled: true,
        accountsClient: accounts,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        client: CLIENT_INFO,
      });
      telemetry.emit(toolRun());

      await expect(telemetry.flush()).resolves.toMatchObject({ status: 'no_token', sent: 0, retained: 1 });
      expect(paths).toEqual([]);
    });

    it('mints an access JWT when the automatic refresh throttle window is open', async () => {
      new AccountStateStore(dataDir).write({ account_id: 'acc_test', email: 'x@example.com' });
      await storeRefreshToken('refresh-token', { dataDir });
      const paths: string[] = [];
      const accounts = new AccountsClient({
        baseUrl: BASE_URL,
        fetchImpl: async (url, init) => {
          const path = new URL(url).pathname;
          paths.push(path);
          if (path === '/auth/refresh') {
            return new Response(JSON.stringify({
              access_token: 'fresh-access',
              access_expires_in_s: 900,
              refresh_token: 'rotated-refresh',
              refresh_expires_at: '2026-12-01T00:00:00.000Z',
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          if (path === '/entitlements/token') {
            return new Response(JSON.stringify({ token: 'ent', valid_until: '2026-12-01T00:00:00.000Z', kid: 'k1' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer fresh-access');
          return ok(1);
        },
      });
      const telemetry = new TelemetryClient({
        dataDir,
        accountsUrl: BASE_URL,
        enabled: true,
        accountsClient: accounts,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        client: CLIENT_INFO,
      });
      telemetry.emit(toolRun());

      await expect(telemetry.flush()).resolves.toMatchObject({ status: 'sent', sent: 1 });
      expect(paths).toEqual(['/auth/refresh', '/entitlements/token', '/telemetry/batch']);
    });

    it('attempts a dead refresh credential at most once per throttle window', async () => {
      new AccountStateStore(dataDir).write({ account_id: 'acc_test', email: 'x@example.com' });
      await storeRefreshToken('dead-refresh-token', { dataDir });
      const paths: string[] = [];
      const accounts = new AccountsClient({
        baseUrl: BASE_URL,
        fetchImpl: async (url) => {
          const path = new URL(url).pathname;
          paths.push(path);
          return err(401, 'invalid_refresh');
        },
      });
      const telemetry = new TelemetryClient({
        dataDir,
        accountsUrl: BASE_URL,
        enabled: true,
        accountsClient: accounts,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        client: CLIENT_INFO,
      });
      telemetry.start();
      try {
        for (let i = 0; i < FLUSH_EVENT_THRESHOLD; i += 1) telemetry.emit(toolRun());
        await vi.waitFor(() => expect(paths).toEqual(['/auth/refresh']));

        for (let i = 0; i < 3; i += 1) {
          clock += MIN_FLUSH_SPACING_MS;
          telemetry.emit(toolRun('fetch'));
          await telemetry.flush();
        }

        expect(new AccountStateStore(dataDir).read().needs_relogin).toBe(true);
        expect(paths).toEqual(['/auth/refresh']);
      } finally {
        telemetry.stop();
      }
    });
  });

  describe('batching', () => {
    it('chunks a large drain to the server event cap', async () => {
      const batchTimes: number[] = [];
      const telemetry = makeTelemetry({ responder: (e) => { batchTimes.push(clock); return ok(e.events.length); } });
      for (let i = 0; i < MAX_EVENTS_PER_BATCH + 3; i += 1) telemetry.emit(toolRun());

      expect(await telemetry.flush()).toMatchObject({ status: 'sent', sent: MAX_EVENTS_PER_BATCH + 3 });
      expect(sentBatches.map((b) => b.events.length)).toEqual([MAX_EVENTS_PER_BATCH, 3]);
      expect(batchTimes[1]! - batchTimes[0]!).toBeGreaterThanOrEqual(MIN_BATCH_SPACING_MS);
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

    it('preserves an event appended by another client during an asynchronous flush', async () => {
      let releaseResponse: (() => void) | undefined;
      const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
      let requestStarted: (() => void) | undefined;
      const requestGate = new Promise<void>((resolve) => { requestStarted = resolve; });
      const draining = makeTelemetry({
        responder: async (e) => {
          requestStarted?.();
          await responseGate;
          return ok(e.events.length);
        },
      });
      draining.emit(toolRun());
      const flush = draining.flush();
      await requestGate;

      const sibling = makeTelemetry();
      expect(sibling.emit(toolRun('fetch'))).toBe(true);
      releaseResponse?.();
      expect(await flush).toMatchObject({ status: 'sent', sent: 1, retained: 1 });
      expect(new TelemetryQueue(dataDir).readAll()).toMatchObject([{ props: { tool: 'fetch' } }]);
    });
  });

  describe('timer', () => {
    it('really auto-flushes when the >=50 threshold is reached', async () => {
      const telemetry = makeTelemetry({ responder: (e) => ok(e.events.length) });
      telemetry.start();
      try {
        for (let i = 0; i < FLUSH_EVENT_THRESHOLD; i += 1) telemetry.emit(toolRun());
        await vi.waitFor(() => expect(sentBatches).toHaveLength(1));
        expect(sentBatches).toHaveLength(1);
        expect(sentBatches[0]?.events).toHaveLength(FLUSH_EVENT_THRESHOLD + 1);
        expect(sentBatches[0]?.events.at(-1)?.name).toBe('daemon.uptime');
      } finally {
        telemetry.stop();
      }
    });

    it('flushes a pre-existing threshold immediately on long-lived startup', async () => {
      const queue = new TelemetryQueue(dataDir);
      for (let i = 0; i < FLUSH_EVENT_THRESHOLD; i += 1) {
        queue.append({ ...toolRun(), ts: new Date(clock).toISOString() });
      }
      const telemetry = makeTelemetry({ responder: (e) => ok(e.events.length) });
      telemetry.start();
      try {
        await vi.waitFor(() => expect(sentBatches).toHaveLength(1));
        expect(sentBatches[0]?.events).toHaveLength(FLUSH_EVENT_THRESHOLD + 1);
      } finally {
        telemetry.stop();
      }
    });

    it('does not parse the queue on threshold emits during cached flush spacing', async () => {
      const telemetry = makeTelemetry({ responder: () => err(503, 'unavailable') });
      telemetry.start();
      try {
        for (let i = 0; i < FLUSH_EVENT_THRESHOLD; i += 1) telemetry.emit(toolRun());
        await telemetry.flush();
        const queueParses = vi.spyOn(TelemetryQueue.prototype, 'readAll');
        queueParses.mockClear();

        for (let i = 0; i < 3; i += 1) {
          telemetry.emit(toolRun('fetch'));
          await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(queueParses).toHaveBeenCalledTimes(0);
        expect(sentBatches).toHaveLength(1);
      } finally {
        telemetry.stop();
      }
    });

    it('does not parse the queue on threshold emits during cached server backoff', async () => {
      const telemetry = makeTelemetry({ responder: () => err(429, 'rate_limited', { retry_after_s: 600 }) });
      telemetry.start();
      try {
        for (let i = 0; i < FLUSH_EVENT_THRESHOLD; i += 1) telemetry.emit(toolRun());
        await telemetry.flush();
        clock += MIN_FLUSH_SPACING_MS;
        const queueParses = vi.spyOn(TelemetryQueue.prototype, 'readAll');
        queueParses.mockClear();

        for (let i = 0; i < 3; i += 1) {
          telemetry.emit(toolRun('fetch'));
          await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(queueParses).toHaveBeenCalledTimes(0);
        expect(sentBatches).toHaveLength(1);
      } finally {
        telemetry.stop();
      }
    });

    it('really flushes on the 15-minute timer and emits daemon uptime', async () => {
      vi.useFakeTimers();
      const telemetry = makeTelemetry({ responder: (e) => ok(e.events.length) });
      telemetry.start();
      telemetry.emit(toolRun());
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS - 1);
      expect(sentBatches).toEqual([]);
      clock += FLUSH_INTERVAL_MS;
      await vi.advanceTimersByTimeAsync(1);
      expect(sentBatches).toHaveLength(1);
      expect(sentBatches[0]?.events.map((event) => event.name)).toEqual(['tool.run', 'daemon.uptime']);
      telemetry.stop();
    });

    it('unrefs the long-lived timer so it does not keep the process alive', () => {
      const telemetry = makeTelemetry();
      telemetry.start();
      try {
        expect(telemetry.timerForTest?.hasRef()).toBe(false);
      } finally {
        telemetry.stop();
      }
    });
  });
});
