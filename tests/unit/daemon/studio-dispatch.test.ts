import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchStudioTool, type StudioHostHandlers, type McpToolResult, type StudioGeneralizeOutput, type StudioCaptureInput } from '../../../src/daemon/studio-dispatch.js';
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
  observe: async () => ({ id: 'snap1', kind: 'full', trusted: false, elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (input) => { actCalls++; return { ok: true, action: input.action, url: input.url }; },
  marks: async () => ({ marks: [] }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
});
const reason = (r: McpToolResult) => JSON.parse(r.content[0].text).error_reason as string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wigolo-dispatch-')); proxyCalls = []; actCalls = 0; setMyInstanceId(null); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); setMyInstanceId(null); });

describe('dispatchStudioTool — execute / proxy / refuse trichotomy (the seam 2I+2J inherit)', () => {
  it('EXECUTE on the host (studioHost set) — runs locally, NEVER proxies', async () => {
    const r = await dispatchStudioTool('studio_observe', { since: 0 }, hostHandlers(), dir, { proxyFactory: proxyReturning({}) });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0].text).id).toBe('snap1');
    expect(JSON.parse(r.content[0].text).trusted).toBe(false); // page-perception payload tagged untrusted, serialized host-side
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

describe('dispatchStudioTool — studio_marks routing', () => {
  it('EXECUTE studio_marks on the host returns the marks view (the agent reads the human marks)', async () => {
    const handlers: StudioHostHandlers = {
      ...hostHandlers(),
      marks: async () => ({ marks: [{ markId: 'm1', role: 'button', name: 'Buy', trusted: false, confidence: 'high', ref: 'e1' }] }),
    };
    const r = await dispatchStudioTool('studio_marks', {}, handlers, dir, { proxyFactory: proxyReturning({}) });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0].text)).toEqual({ marks: [{ markId: 'm1', role: 'button', name: 'Buy', trusted: false, confidence: 'high', ref: 'e1' }] });
    expect(proxyCalls).toEqual([]);
  });

  it('PROXY studio_marks from stdio forwards VERBATIM (trusted:false on each mark survives)', async () => {
    writeHandle(handle({ instanceId: 'host-FOREIGN' }), dir);
    setMyInstanceId('host-MINE');
    const hostResult = { content: [{ type: 'text', text: JSON.stringify({ marks: [{ markId: 'm1', role: 'link', name: 'Home', trusted: false, confidence: 'low' }] }) }], isError: false };
    const r = await dispatchStudioTool('studio_marks', {}, undefined, dir, { proxyFactory: proxyReturning(hostResult) });
    expect(proxyCalls).toEqual([{ name: 'studio_marks', args: {} }]);
    expect(r).toEqual(hostResult); // verbatim — untrusted mark descriptors preserved
  });

  it('EXECUTE studio_marks{op:generalize} routes the op to the host and serializes the preview (refs + confidence + requires_confirmation)', async () => {
    const out: StudioGeneralizeOutput = { markId: 'm1', refs: ['e1', 'e2', 'e3'], confidence: 'high', requires_confirmation: true };
    const handlers: StudioHostHandlers = {
      ...hostHandlers(),
      marks: async (input) => {
        expect(input).toEqual({ op: 'generalize', markId: 'm1' }); // the op + markId reach the host handler intact
        return out;
      },
    };
    const r = await dispatchStudioTool('studio_marks', { op: 'generalize', markId: 'm1' }, handlers, dir, { proxyFactory: proxyReturning({}) });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0].text)).toEqual(out); // requires_confirmation + refs survive serialization
    expect(proxyCalls).toEqual([]);
  });

  it('PROXY studio_marks{op:generalize} forwards the op VERBATIM (preview-only contract preserved across the proxy)', async () => {
    writeHandle(handle({ instanceId: 'host-FOREIGN' }), dir);
    setMyInstanceId('host-MINE');
    const hostResult = { content: [{ type: 'text', text: JSON.stringify({ markId: 'm1', refs: ['e1', 'e2'], confidence: 'medium', requires_confirmation: true }) }], isError: false };
    const r = await dispatchStudioTool('studio_marks', { op: 'generalize', markId: 'm1' }, undefined, dir, { proxyFactory: proxyReturning(hostResult) });
    expect(proxyCalls).toEqual([{ name: 'studio_marks', args: { op: 'generalize', markId: 'm1' } }]);
    expect(r).toEqual(hostResult); // verbatim — requires_confirmation reaches the agent unchanged
  });
});

describe('dispatchStudioTool — studio_capture routing', () => {
  it('EXECUTE studio_capture on the host serializes the capture result (artifact_id + inserted)', async () => {
    const captured: StudioCaptureInput[] = [];
    const handlers: StudioHostHandlers = {
      ...hostHandlers(),
      capture: async (input) => { captured.push(input); return { artifact_id: 7, inserted: true, content_hash: 'abc' }; },
    };
    const r = await dispatchStudioTool('studio_capture', { type: 'clip', content: 'body', url: 'https://x/' }, handlers, dir, { proxyFactory: proxyReturning({}) });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0].text)).toEqual({ artifact_id: 7, inserted: true, content_hash: 'abc' });
    expect(captured).toEqual([{ type: 'clip', content: 'body', url: 'https://x/' }]); // args reach the host handler intact
    expect(proxyCalls).toEqual([]);
  });

  it('EXECUTE studio_capture maps a host StudioToolError to an isError refusal', async () => {
    const handlers: StudioHostHandlers = {
      ...hostHandlers(),
      capture: async () => ({ error_reason: 'unsupported_capture_type', hint: 'clip only' }),
    };
    const r = await dispatchStudioTool('studio_capture', { type: 'qa' }, handlers, dir, { proxyFactory: proxyReturning({}) });
    expect(r.isError).toBe(true);
    expect(reason(r)).toBe('unsupported_capture_type');
  });

  it('PROXY studio_capture from stdio forwards VERBATIM', async () => {
    writeHandle(handle({ instanceId: 'host-FOREIGN' }), dir);
    setMyInstanceId('host-MINE');
    const hostResult = { content: [{ type: 'text', text: JSON.stringify({ artifact_id: 3, inserted: false, content_hash: 'h' }) }], isError: false };
    const r = await dispatchStudioTool('studio_capture', { type: 'clip', content: 'b', url: 'https://x/' }, undefined, dir, { proxyFactory: proxyReturning(hostResult) });
    expect(proxyCalls).toEqual([{ name: 'studio_capture', args: { type: 'clip', content: 'b', url: 'https://x/' } }]);
    expect(r).toEqual(hostResult);
  });
});
