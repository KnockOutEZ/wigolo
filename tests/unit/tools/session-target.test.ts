import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  isSessionTargeted,
  postSessionTarget,
  runSessionCrawl,
  runSessionExtract,
  runSessionFetch,
  type SessionTargetTransport,
} from '../../../src/tools/session-target.js';
import { SESSION_TARGET_ROUTE } from '../../../src/companion-contract/session-target.js';
import { SESSION_TARGET_FIXTURES } from '../../../src/companion-contract/fixtures.js';
import { writeHandle, type SessionHandle } from '../../../src/companion/handle.js';
import { TOOL_SCHEMAS } from '../../../src/server/tool-schemas.js';
import type { CrawlInput, ExtractInput, FetchInput } from '../../../src/types.js';

/**
 * EXTRACT seam 5 — core's session-target tools are a FORWARDING CLIENT, not a composition.
 *
 * The session-scoped fetch / extract / crawl run on the companion, against a live session it owns. Core's
 * side of that is one typed POST and two arms, and the arms are what these tests hold:
 *
 *  - UNPAIRED is an explicit typed refusal. Never a silent downgrade to the ephemeral path — a
 *    session-targeted call that quietly became an anonymous fetch would return a page the caller believes
 *    came from their authenticated session, which is the one outcome this seam exists to prevent.
 *  - PAIRED forwards verbatim and returns the companion's own answer, refusals included, so a refusal the
 *    companion authored reaches the agent in the companion's words rather than being re-narrated here.
 *
 * The host-side pins (control-token gating, the SSRF fence on session navigation, the trusted-0 insert,
 * the credential-page capture refusal) are NOT core's any more: they belong to the side that owns the
 * browser, and their e2e lives with it (spec §10, app e2e).
 */

const REFUSAL_HINT = /companion/i;

function handleFor(port: number): SessionHandle {
  return { id: 's1', endpoint: `http://127.0.0.1:${port}`, token: 'tok-abc', pid: 1, instanceId: 'other' };
}

describe('isSessionTargeted — the routing predicate', () => {
  it('is the contract predicate, so client and companion cannot disagree about what "targeted" means', () => {
    expect(isSessionTargeted({ session_id: 'sess-1' })).toBe(true);
    expect(isSessionTargeted({ session_id: '   ' })).toBe(false);
    expect(isSessionTargeted({})).toBe(false);
  });
});

describe('session-target forwarding client — the UNPAIRED refusal arm', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-st-refuse-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a session fetch with companion_unavailable when no companion has published a handle', async () => {
    const r = await runSessionFetch({ url: 'https://example.com', session_id: 's1' } as FetchInput, { dataDir: dir });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('companion_unavailable');
    expect(r.stage).toBe('fetch');
    expect(r.hint).toMatch(REFUSAL_HINT);
  });

  it.each([
    ['extract', (deps: { dataDir: string }) => runSessionExtract({ session_id: 's1' } as ExtractInput, deps)],
    ['crawl', (deps: { dataDir: string }) => runSessionCrawl({ url: 'https://example.com', session_id: 's1' } as CrawlInput, deps)],
  ] as const)('refuses a session %s the same way, stamped with its own stage', async (stage, run) => {
    const r = await run({ dataDir: dir });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('companion_unavailable');
    expect(r.stage).toBe(stage);
  });

  it('never reaches the transport when unpaired — the refusal is decided before any I/O', async () => {
    const call = vi.fn<SessionTargetTransport>(async () => null);
    await runSessionFetch({ url: 'https://example.com', session_id: 's1' } as FetchInput, { dataDir: dir, call });
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses — never downgrades — when the handle is live but the companion cannot be reached', async () => {
    // A stale handle file (the companion died without removing it) is the common case, and the failure mode
    // that matters is the one where core "helpfully" runs an anonymous fetch instead. The refusal keeps the
    // caller's mistake visible; a downgrade would hand them a page from the wrong browser.
    writeHandle(handleFor(1), dir);
    const call = vi.fn<SessionTargetTransport>(async () => null);
    const r = await runSessionFetch({ url: 'https://example.com', session_id: 's1' } as FetchInput, { dataDir: dir, call });
    expect(call).toHaveBeenCalledOnce();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('companion_unavailable');
    expect(r.error_reason).toMatch(/reach|unreachable|answer/i);
  });
});

describe('session-target forwarding client — the PAIRED forward arm', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-st-forward-'));
    writeHandle(handleFor(1), dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('forwards the op, the session id and the input verbatim, and returns the companion data', async () => {
    const seen: unknown[] = [];
    const call = vi.fn<SessionTargetTransport>(async (_handle, request) => {
      seen.push(request);
      return { ok: true, data: { url: 'https://example.com/live', markdown: 'live page' } };
    });
    const input = { url: 'https://example.com', session_id: 'sess-9', max_chars: 500 } as FetchInput;
    const r = await runSessionFetch(input, { dataDir: dir, call });
    expect(seen[0]).toEqual({ op: 'fetch', session_id: 'sess-9', input });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.markdown).toBe('live page');
  });

  it('passes a companion refusal through in the companion’s own words, not a re-narration', async () => {
    // The companion owns the reason: a pacing-budget or authenticated-use refusal arrives with live counters
    // in its sentence, and flattening it to a generic failure here would make a VISIBLE budget invisible.
    const call = vi.fn<SessionTargetTransport>(async () => ({
      ok: false as const,
      error: 'not_holder' as const,
      error_reason: 'The human holds control of this session.',
      stage: 'fetch' as const,
      hint: 'Observe and wait for a grant.',
    }));
    const r = await runSessionFetch({ url: 'https://example.com', session_id: 's1' } as FetchInput, { dataDir: dir, call });
    expect(r).toEqual({
      ok: false,
      error: 'not_holder',
      error_reason: 'The human holds control of this session.',
      stage: 'fetch',
      hint: 'Observe and wait for a grant.',
    });
  });

  it('routes extract and crawl to their own ops rather than collapsing to fetch', async () => {
    const ops: string[] = [];
    const call = vi.fn<SessionTargetTransport>(async (_h, request) => {
      ops.push((request as { op: string }).op);
      return { ok: true, data: {} };
    });
    await runSessionExtract({ session_id: 's1' } as ExtractInput, { dataDir: dir, call });
    await runSessionCrawl({ url: 'https://example.com', session_id: 's1' } as CrawlInput, { dataDir: dir, call });
    expect(ops).toEqual(['extract', 'crawl']);
  });
});

/**
 * The wire itself, against a real local HTTP server: the arms that decide whether a companion fault stays
 * visible to the user or turns into a crash / a fabricated success.
 */
describe('postSessionTarget — the wire', () => {
  let server: Server;
  let seen: { url?: string; auth?: string; body?: string };
  let reply: (body: string, status: number) => void;
  let handle: SessionHandle;

  beforeEach(async () => {
    seen = {};
    let nextReply = { body: JSON.stringify({ ok: true, data: { markdown: 'x' } }), status: 200 };
    reply = (body, status) => {
      nextReply = { body, status };
    };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen = { url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf-8') };
        res.writeHead(nextReply.status, { 'content-type': 'application/json' });
        res.end(nextReply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    handle = handleFor((server.address() as AddressInfo).port);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const request = { op: 'fetch' as const, session_id: 's1', input: { url: 'https://example.com' } };

  it('POSTs the contract route with the handle bearer token and the request body', async () => {
    const answer = await postSessionTarget(handle, request);
    expect(seen.url).toBe(SESSION_TARGET_ROUTE);
    expect(seen.auth).toBe('Bearer tok-abc');
    expect(JSON.parse(seen.body ?? '{}')).toEqual(request);
    expect(answer).toEqual({ ok: true, data: { markdown: 'x' } });
  });

  it('returns a typed refusal even when the companion answers it with a 4xx', async () => {
    // Status is not the gate: a refusal carries its code in the BODY, and collapsing it to a transport
    // failure would lose the difference between "the companion refused" and "no companion answered".
    reply(JSON.stringify({ ok: false, error: 'no_such_session', error_reason: 'gone', stage: 'fetch' }), 404);
    expect(await postSessionTarget(handle, request)).toMatchObject({ ok: false, error: 'no_such_session' });
  });

  it('returns null on a refusal code outside the closed enum — an undeclared reason is not a wire answer', async () => {
    reply(JSON.stringify({ ok: false, error: 'made_up', error_reason: 'x', stage: 'fetch' }), 200);
    expect(await postSessionTarget(handle, request)).toBeNull();
  });

  it('returns null on a non-JSON body rather than throwing into the tool dispatch', async () => {
    reply('not json at all', 200);
    expect(await postSessionTarget(handle, request)).toBeNull();
  });

  it('returns null on a 5xx with no typed body — a broken companion is not a success', async () => {
    reply(JSON.stringify({ ok: true, data: { markdown: 'x' } }), 500);
    expect(await postSessionTarget(handle, request)).toBeNull();
  });

  it('returns null when the endpoint is dead — the stale-handle case, never a throw', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await postSessionTarget({ ...handle, endpoint: 'http://127.0.0.1:1' }, request)).toBeNull();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  it('tolerates an endpoint published with a trailing slash', async () => {
    await postSessionTarget({ ...handle, endpoint: `${handle.endpoint}/` }, request);
    expect(seen.url).toBe(SESSION_TARGET_ROUTE);
  });
});

/**
 * Spec §10's negative grep, in the form that survives the deletion: core's OWN tools must not name a
 * companion tool in their parameter text. Today the studio_* tools are still registered here, so the sweep
 * is scoped to the non-companion half; when the deletion takes them the same assertion covers everything.
 */
describe('core tool descriptions carry capability language, not companion tool names', () => {
  const coreTools = Object.keys(TOOL_SCHEMAS).filter((n) => !n.startsWith('studio_'));

  function descriptionsOf(node: unknown, out: string[]): void {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.description === 'string') out.push(obj.description);
    const props = obj.properties as Record<string, unknown> | undefined;
    if (props) for (const v of Object.values(props)) descriptionsOf(v, out);
    if (obj.items) descriptionsOf(obj.items, out);
  }

  it('names no studio_ tool in any core tool schema description', () => {
    expect(coreTools.length).toBeGreaterThan(0);
    for (const name of coreTools) {
      const found: string[] = [];
      descriptionsOf(TOOL_SCHEMAS[name as keyof typeof TOOL_SCHEMAS], found);
      for (const d of found) {
        expect(d, `${name} names a companion tool in its parameter text`).not.toMatch(/studio_/);
      }
    }
  });
});

/**
 * Spec §10's OTHER half, mirrored into core's own suite.
 *
 * #474 pinned `POST /companion/session` at route level — but both halves of that pin live in the studio
 * repo, so they only run when that repo bumps its core pin. Until then core's suite can go green on a
 * forwarding client that no longer speaks the address it posts at. These arms close that: a stub companion
 * that serves exactly ONE address — {@link SESSION_TARGET_ROUTE}, imported for the same reason the client
 * imports it, never a literal — answering the SHARED {@link SESSION_TARGET_FIXTURES}, driven through the
 * real handle file by the real transport. A client that drifts off the constant 404s here, where a 404 is
 * indistinguishable from an absent companion, instead of in production.
 */
describe('the session-target route, end to end against a stub companion', () => {
  interface StubCompanion {
    endpoint: string;
    handle: SessionHandle;
    requests: { url: string; body: unknown }[];
    close: () => Promise<void>;
  }

  /** A companion that answers `servedAt` and 404s every other address — the shape of a one-sided move. */
  async function startCompanion(servedAt: string, answer: unknown, status = 200): Promise<StubCompanion> {
    const requests: { url: string; body: unknown }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        requests.push({ url: req.url ?? '', body: raw === '' ? null : JSON.parse(raw) });
        const hit = req.url === servedAt;
        res.writeHead(hit ? status : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(hit ? answer : { error: 'no such route' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      endpoint,
      handle: { id: 's1', endpoint, token: 'tok-abc', pid: 1, instanceId: 'other' },
      requests,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  /** The shared request fixture, expressed as the tool input the forwarding client actually takes. */
  const sessionInput = {
    ...SESSION_TARGET_FIXTURES.request.input,
    session_id: SESSION_TARGET_FIXTURES.request.session_id,
  } as FetchInput;

  let dir: string;
  let companion: StubCompanion;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-st-route-'));
  });
  afterEach(async () => {
    await companion.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('forwards the shared request to the contract address and returns the companion data', async () => {
    companion = await startCompanion(SESSION_TARGET_ROUTE, SESSION_TARGET_FIXTURES.okResult);
    writeHandle(companion.handle, dir);
    const r = await runSessionFetch(sessionInput, { dataDir: dir });
    expect(companion.requests.map((q) => q.url)).toEqual([SESSION_TARGET_ROUTE]);
    expect(companion.requests[0].body).toMatchObject({
      op: SESSION_TARGET_FIXTURES.request.op,
      session_id: SESSION_TARGET_FIXTURES.request.session_id,
    });
    expect(r).toEqual(SESSION_TARGET_FIXTURES.okResult);
  });

  it('passes the shared refusal fixture through verbatim from that same address', async () => {
    companion = await startCompanion(SESSION_TARGET_ROUTE, SESSION_TARGET_FIXTURES.refusal);
    writeHandle(companion.handle, dir);
    expect(await runSessionFetch(sessionInput, { dataDir: dir })).toEqual(SESSION_TARGET_FIXTURES.refusal);
  });

  it('refuses companion_unavailable when the answer is served at a MOVED address', async () => {
    // The companion here answers a real result, just not at the address the wire publishes. A 404 at the
    // client is indistinguishable from an absent companion, which is exactly why the address belongs to the
    // contract module both sides import rather than to either side's own literal. The refusal is still
    // typed: never a silent downgrade to the ephemeral path.
    companion = await startCompanion(`${SESSION_TARGET_ROUTE}-v2`, SESSION_TARGET_FIXTURES.okResult);
    writeHandle(companion.handle, dir);
    const r = await runSessionFetch(sessionInput, { dataDir: dir });
    expect(companion.requests.map((q) => q.url)).toEqual([SESSION_TARGET_ROUTE]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('companion_unavailable');
    expect(r.stage).toBe('fetch');
  });

  it('puts the shared request on the wire unchanged, and returns null from the moved address', async () => {
    companion = await startCompanion(SESSION_TARGET_ROUTE, SESSION_TARGET_FIXTURES.okResult);
    expect(await postSessionTarget(companion.handle, SESSION_TARGET_FIXTURES.request)).toEqual(
      SESSION_TARGET_FIXTURES.okResult,
    );
    expect(companion.requests[0].body).toEqual(SESSION_TARGET_FIXTURES.request);
    await companion.close();
    companion = await startCompanion(`${SESSION_TARGET_ROUTE}/v2`, SESSION_TARGET_FIXTURES.okResult);
    expect(await postSessionTarget(companion.handle, SESSION_TARGET_FIXTURES.request)).toBeNull();
  });
});
