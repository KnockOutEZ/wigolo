import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchStudioTool, type StudioHostHandlers, type McpToolResult } from '../../../src/daemon/studio-dispatch.js';
import { writeHandle, setMyInstanceId, type SessionHandle } from '../../../src/studio/handle.js';

let dir: string;
let proxyCalls: Array<{ name: string; args: Record<string, unknown> }>;
let actCalls: number; // host-side act() invocations — proves authorization runs on the host, never the proxy side

const handle = (over: Partial<SessionHandle> = {}): SessionHandle => ({ id: 's', endpoint: 'http://127.0.0.1:65000', token: 't', pid: process.pid, instanceId: 'host-A', ...over });
const proxyReturning = (result: unknown) => () => ({
  callTool: async (name: string, args: Record<string, unknown>) => { proxyCalls.push({ name, args }); return result; },
});
const throwingProxy = () => () => ({ callTool: async () => { throw new Error('ECONNREFUSED'); } });
const hostHandlers = (): StudioHostHandlers => ({
  observe: async () => ({ id: 'snap1', kind: 'full', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (input) => { actCalls++; return { ok: true, action: input.action, url: input.url }; },
});
const reason = (r: McpToolResult) => JSON.parse(r.content[0].text).error_reason as string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wigolo-dispatch-')); proxyCalls = []; actCalls = 0; setMyInstanceId(null); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); setMyInstanceId(null); });

describe('dispatchStudioTool — execute / proxy / refuse trichotomy (the seam 2I+2J inherit)', () => {
  it('EXECUTE on the host (studioHost set) — runs locally, NEVER proxies', async () => {
    const r = await dispatchStudioTool('studio_observe', { since: 0 }, hostHandlers(), dir, { proxyFactory: proxyReturning({}) });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0].text).id).toBe('snap1');
    expect(proxyCalls).toEqual([]);
  });

  it('PROXY to a FOREIGN live host (no studioHost, instanceId ≠ mine) — passes the result VERBATIM (trusted tag survives)', async () => {
    writeHandle(handle({ instanceId: 'host-FOREIGN' }), dir);
    setMyInstanceId('host-MINE');
    const hostResult = { content: [{ type: 'text', text: JSON.stringify({ id: 'snapX', vision: { trusted: false } }) }], isError: false };
    const r = await dispatchStudioTool('studio_observe', { since: 2 }, undefined, dir, { proxyFactory: proxyReturning(hostResult) });
    expect(proxyCalls).toEqual([{ name: 'studio_observe', args: { since: 2 } }]);
    expect(r).toEqual(hostResult); // verbatim — no reconstruction
    expect(JSON.parse(r.content[0].text).vision.trusted).toBe(false); // host → proxy → agent, tag intact
  });

  it('REFUSE-SELF (handle.instanceId === mine) — refuses, NEVER proxies → the no-self-loop guarantee', async () => {
    setMyInstanceId('host-A');
    writeHandle(handle({ instanceId: 'host-A' }), dir);
    const r = await dispatchStudioTool('studio_observe', {}, undefined, dir, { proxyFactory: proxyReturning({}) });
    expect(r.isError).toBe(true);
    expect(reason(r)).toBe('studio_self_reference');
    expect(proxyCalls).toEqual([]); // did NOT read its own handle and proxy into a loop
  });

  it('PID REUSE does NOT false-match: same pid but a different instanceId → PROXY, not refuse-self', async () => {
    setMyInstanceId('host-NEW');
    writeHandle(handle({ pid: process.pid, instanceId: 'host-OLD-DEAD' }), dir); // stale handle, OS reused our pid
    const r = await dispatchStudioTool('studio_observe', {}, undefined, dir, { proxyFactory: proxyReturning({ content: [{ type: 'text', text: '{}' }], isError: false }) });
    expect(proxyCalls.length).toBe(1); // proxied to the live foreign host — bare-pid would have wrongly refused-self
    expect(r.isError).toBe(false);
  });

  it('REFUSE no_studio_session when no handle is published', async () => {
    const r = await dispatchStudioTool('studio_observe', {}, undefined, dir, { proxyFactory: proxyReturning({}) });
    expect(r.isError).toBe(true);
    expect(reason(r)).toBe('no_studio_session');
  });

  it('REFUSE studio_host_unreachable (fail loud, no hang) when the host endpoint is dead', async () => {
    writeHandle(handle({ instanceId: 'host-FOREIGN' }), dir);
    setMyInstanceId('host-MINE');
    const r = await dispatchStudioTool('studio_observe', {}, undefined, dir, { proxyFactory: throwingProxy() });
    expect(r.isError).toBe(true);
    expect(reason(r)).toBe('studio_host_unreachable');
  });
});

describe('dispatchStudioTool — studio_act routing (authorization is HOST-SIDE)', () => {
  it('EXECUTE studio_act on the host runs the host handler (where the control-token gate lives)', async () => {
    const r = await dispatchStudioTool('studio_act', { action: 'navigate', url: 'https://example.com/' }, hostHandlers(), dir, { proxyFactory: proxyReturning({}) });
    expect(actCalls).toBe(1); // the gate ran host-side
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, action: 'navigate', url: 'https://example.com/' });
    expect(proxyCalls).toEqual([]);
  });

  it('PROXY studio_act from stdio forwards VERBATIM and makes NO authorization decision (dumb passthrough)', async () => {
    writeHandle(handle({ instanceId: 'host-FOREIGN' }), dir);
    setMyInstanceId('host-MINE');
    const hostResult = { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'navigate' }) }], isError: false };
    const r = await dispatchStudioTool('studio_act', { action: 'navigate', url: 'https://x/' }, undefined, dir, { proxyFactory: proxyReturning(hostResult) });
    expect(proxyCalls).toEqual([{ name: 'studio_act', args: { action: 'navigate', url: 'https://x/' } }]); // forwarded
    expect(actCalls).toBe(0); // the stdio side ran NO gate — a caller here can't satisfy or bypass it
    expect(r).toEqual(hostResult); // verbatim
  });

  it('REFUSE studio_act with no session (no handle) — a clean refusal, not a gate decision', async () => {
    const r = await dispatchStudioTool('studio_act', { action: 'navigate', url: 'https://x/' }, undefined, dir, { proxyFactory: proxyReturning({}) });
    expect(r.isError).toBe(true);
    expect(reason(r)).toBe('no_studio_session');
    expect(actCalls).toBe(0);
  });
});
