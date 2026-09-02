import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  companionBridgeFetch,
  companionBridgeAvailable,
  postEscalation,
  type EscalationTransport,
} from '../../../src/fetch/companion-bridge.js';
import { ESCALATION_ROUTE, STUDIO_FETCH_CAPABILITY } from '../../../src/companion-contract/escalation.js';
import type { EscalationResponse } from '../../../src/companion-contract/escalation.js';
import type { SessionHandle } from '../../../src/companion/handle.js';
import { readEscalationCounters } from '../../../src/companion/escalation-counters.js';

/**
 * S9 slice 1 — the core-side bridge client, now speaking the §4 escalation wire over plain HTTP.
 *
 * The rung is OPPORTUNISTIC by design. Everything here encodes one rule: a bridge that is absent, dead,
 * refusing, or returning nonsense must degrade to `null` so the caller keeps its honest challenge report.
 * A bridge fault must never become the user's error.
 */

let dir: string;

function publishHandle(endpoint = 'http://127.0.0.1:1'): void {
  mkdirSync(join(dir, 'studio'), { recursive: true });
  writeFileSync(
    join(dir, 'studio', 'current.json'),
    JSON.stringify({ id: 's1', endpoint, token: 't', pid: 1, instanceId: 'other' }),
  );
}

/** A transport stub bound to the REAL seam type, so a drifting wire reds here rather than at runtime. */
function transport(answer: EscalationResponse | null): EscalationTransport {
  return vi.fn(async () => answer);
}

const SERVED: EscalationResponse = {
  ok: true,
  url: 'https://walled.example/final',
  html: '<html>real content</html>',
  session_id: 's1',
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wig-bridge-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('companionBridgeAvailable — the live-session gate', () => {
  it('is false with no published handle, so a default install never pays for the rung', () => {
    expect(companionBridgeAvailable(dir)).toBe(false);
  });

  it('is true once a companion publishes a handle', () => {
    publishHandle();
    expect(companionBridgeAvailable(dir)).toBe(true);
  });
});

describe('companionBridgeFetch', () => {
  it('does not call the transport at all when no session is published and none can be started', async () => {
    const call = vi.fn();
    const ensureRunning = vi.fn(async () => null);
    expect(await companionBridgeFetch('https://walled.example/', { dataDir: dir, call, ensureRunning })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('returns browser-tier bytes when the companion serves the page', async () => {
    publishHandle();
    const call = transport(SERVED);
    const r = await companionBridgeFetch('https://walled.example/', { dataDir: dir, call });
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'http://127.0.0.1:1', token: 't' }),
      { capability: STUDIO_FETCH_CAPABILITY, url: 'https://walled.example/' },
    );
    expect(r).toMatchObject({
      url: 'https://walled.example/',
      finalUrl: 'https://walled.example/final',
      html: '<html>real content</html>',
      statusCode: 200,
      method: 'browser',
      escalated: true,
    });
  });

  it('declines on a typed refusal — the caller keeps its own blocked_by_challenge', async () => {
    publishHandle();
    const call = transport({ ok: false, error_reason: 'capture_refused', error: 'a credential page is open' });
    expect(await companionBridgeFetch('https://walled.example/login', { dataDir: dir, call })).toBeNull();
  });

  it('declines when the transport reports failure — a dead companion is never the user-visible error', async () => {
    publishHandle();
    expect(await companionBridgeFetch('https://walled.example/', { dataDir: dir, call: transport(null) })).toBeNull();
  });

  it('declines on an EMPTY body — "" is not a successful fetch, it is a blank tab', async () => {
    publishHandle();
    const call = transport({ ok: true, url: 'https://walled.example/', html: '', session_id: 's1' });
    expect(await companionBridgeFetch('https://walled.example/', { dataDir: dir, call })).toBeNull();
  });

  it('declines when ok is absent even though html is present — the success flag is the contract', async () => {
    publishHandle();
    const call = transport({ url: 'https://walled.example/', html: '<html>x</html>' } as unknown as EscalationResponse);
    expect(await companionBridgeFetch('https://walled.example/', { dataDir: dir, call })).toBeNull();
  });

  it('counts an attempt before the answer, and a decline as a decline', async () => {
    publishHandle();
    await companionBridgeFetch('https://walled.example/', { dataDir: dir, call: transport(null) });
    expect(readEscalationCounters(dir)).toMatchObject({ bridgeAttempted: 1, bridgeDeclined: 1, bridgeServed: 0 });
    await companionBridgeFetch('https://walled.example/', { dataDir: dir, call: transport(SERVED) });
    expect(readEscalationCounters(dir)).toMatchObject({ bridgeAttempted: 2, bridgeDeclined: 1, bridgeServed: 1 });
  });
});

describe('companionBridgeFetch — amended-D4 auto-launch', () => {
  it('starts the substrate when none is running, then serves the page', async () => {
    // Starting a process is not a consent event: the session opens on a clean in-memory profile, and D9's
    // grant card is what gates spending the human's signed-in identity.
    const ensureRunning = vi.fn(async () => { publishHandle(); return { endpoint: 'x' }; });
    const call = transport({ ...SERVED, html: '<html>after launch</html>' });
    const r = await companionBridgeFetch('https://walled.example/', { dataDir: dir, call, ensureRunning });
    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(r?.html).toBe('<html>after launch</html>');
  });

  it('does NOT try to launch when a session is already published', async () => {
    publishHandle();
    const ensureRunning = vi.fn(async () => null);
    await companionBridgeFetch('https://walled.example/', { dataDir: dir, call: transport(SERVED), ensureRunning });
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it('declines cleanly when the substrate cannot be started — no session, no error, no hang', async () => {
    const ensureRunning = vi.fn(async () => null);
    const call = vi.fn();
    expect(await companionBridgeFetch('https://walled.example/', { dataDir: dir, call, ensureRunning })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('declines when the launch published nothing readable — a half-started companion is still no companion', async () => {
    // `ensureRunning` resolving truthy is not proof of a handle on disk; the bridge re-reads the file, and
    // an empty read has to decline BEFORE any counter moves or any request is built.
    const ensureRunning = vi.fn(async () => ({ endpoint: 'http://127.0.0.1:1' }));
    const call = vi.fn();
    expect(await companionBridgeFetch('https://walled.example/', { dataDir: dir, call, ensureRunning })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(readEscalationCounters(dir)).toMatchObject({ bridgeAttempted: 0 });
  });
});

/**
 * The transport itself, against a REAL local HTTP server. The old bridge borrowed the studio dispatch
 * proxy, so nothing here was core's to test; the wire POST is now core's own ~30 lines and its failure
 * arms are the ones that decide whether a companion fault stays invisible to the user.
 */
describe('postEscalation — the wire', () => {
  let server: Server;
  let seen: { url?: string; auth?: string; body?: string };
  let reply: (body: string, status: number) => void;
  let handle: SessionHandle;

  beforeEach(async () => {
    seen = {};
    let nextReply: { body: string; status: number } = { body: JSON.stringify(SERVED), status: 200 };
    reply = (body, status) => { nextReply = { body, status }; };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen = {
          url: req.url,
          auth: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf-8'),
        };
        res.writeHead(nextReply.status, { 'content-type': 'application/json' });
        res.end(nextReply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    handle = { id: 's1', endpoint: `http://127.0.0.1:${port}`, token: 'tok-abc', pid: 1, instanceId: 'other' };
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('POSTs the contract route with the handle bearer token and the request body', async () => {
    const answer = await postEscalation(handle, { capability: STUDIO_FETCH_CAPABILITY, url: 'https://walled.example/' });
    expect(seen.url).toBe(ESCALATION_ROUTE);
    expect(seen.auth).toBe('Bearer tok-abc');
    expect(JSON.parse(seen.body ?? '{}')).toEqual({ capability: 'studio_fetch', url: 'https://walled.example/' });
    expect(answer).toEqual(SERVED);
  });

  it('returns a typed decline even when the companion answers it with a 4xx', async () => {
    // Status is not the gate: a refusal carries its reason in the BODY, and collapsing it to a transport
    // failure would lose the difference between "refused" and "unreachable" that the counters exist for.
    reply(JSON.stringify({ ok: false, error_reason: 'not_holder', error: 'the human is driving' }), 403);
    const answer = await postEscalation(handle, { capability: STUDIO_FETCH_CAPABILITY, url: 'https://walled.example/' });
    expect(answer).toMatchObject({ ok: false, error_reason: 'not_holder' });
  });

  it('returns null for a body that satisfies neither arm rather than fabricating a page', async () => {
    reply(JSON.stringify({ ok: true, html: '<html>x</html>' }), 200);
    expect(await postEscalation(handle, { capability: STUDIO_FETCH_CAPABILITY, url: 'https://walled.example/' })).toBeNull();
  });

  it('returns null on a non-JSON body', async () => {
    reply('not json at all', 200);
    expect(await postEscalation(handle, { capability: STUDIO_FETCH_CAPABILITY, url: 'https://walled.example/' })).toBeNull();
  });

  it('returns null on a decline code outside the closed enum — an undeclared reason is not a wire answer', async () => {
    reply(JSON.stringify({ ok: false, error_reason: 'made_up', error: 'x' }), 200);
    expect(await postEscalation(handle, { capability: STUDIO_FETCH_CAPABILITY, url: 'https://walled.example/' })).toBeNull();
  });

  it('returns null when the endpoint is dead — the stale-handle case, never a throw', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const answer = await postEscalation(
      { ...handle, endpoint: 'http://127.0.0.1:1' },
      { capability: STUDIO_FETCH_CAPABILITY, url: 'https://walled.example/' },
    );
    expect(answer).toBeNull();
    // Re-listen so the shared afterEach close is a no-op rather than a double-close throw.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  it('tolerates an endpoint published with a trailing slash', async () => {
    await postEscalation(
      { ...handle, endpoint: `${handle.endpoint}/` },
      { capability: STUDIO_FETCH_CAPABILITY, url: 'https://walled.example/' },
    );
    expect(seen.url).toBe(ESCALATION_ROUTE);
  });
});
