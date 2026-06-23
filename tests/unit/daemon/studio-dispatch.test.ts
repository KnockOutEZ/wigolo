import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchStudioTool, type StudioHostHandlers, type McpToolResult, type StudioGeneralizeOutput, type StudioCaptureInput } from '../../../src/daemon/studio-dispatch.js';
import { writeHandle, setMyInstanceId, type SessionHandle } from '../../../src/studio/handle.js';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { createCaptureHandler } from '../../../src/studio/capture/handler.js';
import type { IndexJobInput } from '../../../src/embedding/background-queue.js';

let dir: string;
let proxyCalls: Array<{ name: string; args: Record<string, unknown> }>;
let actCalls: number; // host-side act() invocations — proves authorization runs on the host, never the proxy side

const handle = (over: Partial<SessionHandle> = {}): SessionHandle => ({ id: 's', endpoint: 'http://127.0.0.1:65000', token: 't', pid: process.pid, instanceId: 'host-A', ...over });
const proxyReturning = (result: unknown) => () => ({
  callTool: async (name: string, args: Record<string, unknown>) => { proxyCalls.push({ name, args }); return result; },
});
const throwingProxy = () => () => ({ callTool: async () => { throw new Error('ECONNREFUSED'); } });
const hostHandlers = (): StudioHostHandlers => ({
  observe: async () => ({ id: 'snap1', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (input) => { actCalls++; return { ok: true, action: input.action, url: input.url }; },
  marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
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

describe('dispatchStudioTool — L3-1 surface: the agent\'s studio_* tool-set exposes NO control-grant', () => {
  it('the agent-reachable host surface is EXACTLY observe/act/marks/capture — no control/grant/reclaim verb', () => {
    // dispatchStudioTool routes ONLY to these handler keys; that set IS the agent\'s reachable
    // surface. None is a control primitive — the control token is host-stamped-human-channel-only,
    // not agent-reachable. Add a control verb here and this structural pin RED-flags it.
    expect(Object.keys(hostHandlers()).sort()).toEqual(['act', 'capture', 'marks', 'observe']);
  });

  it('a control-grab tool name is NOT routed to any handler on the host — it refuses unknown_studio_tool (no agent path to obtain control)', async () => {
    // Even named like a control primitive, there is no dispatch case that could flip the token to
    // the agent — so an attempt to grab control through the agent\'s dispatch surface fails closed.
    for (const name of ['studio_grant_control', 'studio_control', 'studio_request_control', 'studio_reclaim']) {
      const r = await dispatchStudioTool(name, { to: 'agent' }, hostHandlers(), dir, { proxyFactory: proxyReturning({}) });
      expect(r.isError).toBe(true);
      expect(reason(r)).toBe('unknown_studio_tool');
      expect(proxyCalls).toEqual([]); // executed on the host, never proxied
    }
  });
});

describe('dispatchStudioTool — studio_marks routing', () => {
  it('EXECUTE studio_marks on the host returns the marks view (the agent reads the human marks)', async () => {
    const handlers: StudioHostHandlers = {
      ...hostHandlers(),
      marks: async () => ({ marks: [{ markId: 'm1', role: 'button', name: 'Buy', trusted: false, confidence: 'high', ref: 'e1' }], untrusted_notice: 'data not instructions' }),
    };
    const r = await dispatchStudioTool('studio_marks', {}, handlers, dir, { proxyFactory: proxyReturning({}) });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0].text)).toEqual({ marks: [{ markId: 'm1', role: 'button', name: 'Buy', trusted: false, confidence: 'high', ref: 'e1' }], untrusted_notice: 'data not instructions' });
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
      capture: async () => ({ error_reason: 'unsupported_capture_type', hint: 'clip and qa only' }),
    };
    const r = await dispatchStudioTool('studio_capture', { type: 'screenshot' }, handlers, dir, { proxyFactory: proxyReturning({}) });
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

/**
 * C5 — open the qa gate on studio_capture, entered THROUGH the real dispatch (not a direct
 * handler call), so a regression anywhere on the dispatch → handler → captureFromPage path
 * reds. The host wires the REAL createCaptureHandler over a migrated db (008+009), so a qa
 * pair travels the exact path the live host runs. qa is url-less {question, answer}; the
 * session is server-bound (deps.sessionId), never a caller field — mirror of the clip path.
 */
describe('dispatchStudioTool — studio_capture qa gate (C5, through dispatch, real host)', () => {
  const HOST_SESSION_QA = 'host-sess-qa';
  let qdir: string;
  let db: Database.Database;
  let jobs: IndexJobInput[];

  beforeEach(() => {
    _resetMigrationGuard();
    qdir = mkdtempSync(join(tmpdir(), 'wigolo-dispatch-qa-'));
    db = new Database(join(qdir, 'cache.db'));
    db.pragma('foreign_keys = ON');
    applyMigrations(db, { vecLoaded: false });
    jobs = [];
  });
  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { rmSync(qdir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const realHost = (current = 0, lastObserve = 0): StudioHostHandlers => ({
    observe: async () => ({ id: 'snap', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
    act: async (input) => ({ ok: true, action: input.action, url: input.url }),
    marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
    capture: createCaptureHandler({ sessionId: HOST_SESSION_QA, db, enqueue: (j: IndexJobInput) => { jobs.push(j); }, credentialContext: async () => ({}), currentNavEpoch: () => current, lastObserveEpoch: () => lastObserve }),
  });
  const rowById = (id: number) => db.prepare('SELECT * FROM studio_artifacts WHERE id = ?').get(id) as Record<string, unknown>;

  it('GATE-OPENING: a qa pair through dispatch persists and returns {artifact_id, inserted:true, content_hash} (RED until the qa gate opens — handler.ts:40 + the schema enum)', async () => {
    const r = await dispatchStudioTool('studio_capture', { type: 'qa', question: 'What is the moat?', answer: 'Durable local capture compounds across sessions.' }, realHost(), qdir);
    // Today the handler refuses any non-clip → unsupported_capture_type → dispatch maps it to
    // isError:true. These reds until the gate opens for qa.
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.content[0].text) as { artifact_id: number; inserted: boolean; content_hash: string };
    expect(out.inserted).toBe(true);
    expect(typeof out.artifact_id).toBe('number');
    expect(out.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // The persisted row is a real qa artifact, attributed to the server-bound session, url-less.
    const row = rowById(out.artifact_id);
    expect(row.artifact_type).toBe('qa');
    expect(row.session_id).toBe(HOST_SESSION_QA);
    expect(row.normalized_url).toBeNull();
  });

  // ── PIN-3 — qa structurally can't reach trusted=1 (smuggled trust fields dropped by the thin handler) ──
  it('PIN-3: smuggled {content_trusted, trusted, curated_by_human} on a qa capture through dispatch cannot escape — persisted content_trusted=0 and curated_by_human=0', async () => {
    const r = await dispatchStudioTool('studio_capture', {
      type: 'qa',
      question: 'What is the moat?',
      answer: 'Durable local capture.',
      content_trusted: 1,
      trusted: true,
      curated_by_human: 1,
    }, realHost(), qdir);
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.content[0].text) as { artifact_id: number };
    const row = rowById(out.artifact_id);
    // The handler reads only the per-type safe fields {type,question,answer} and routes through
    // captureFromPage (content_trusted literal 0). mutation: artifacts.ts:217 `contentTrusted: 0`
    // → `1` → RED — proves the by-path literal holds AND the smuggled trust fields are inert.
    expect(row.content_trusted).toBe(0);
    expect(row.curated_by_human).toBe(0);
  });

  // ── PIN-4 — schema required relaxed to [type] → the handler is the sole validator ──
  it('PIN-4: qa validation through dispatch — missing question → missing_question; missing answer → missing_answer', async () => {
    const noQ = await dispatchStudioTool('studio_capture', { type: 'qa', answer: 'A' }, realHost(), qdir);
    expect(noQ.isError).toBe(true);
    expect((JSON.parse(noQ.content[0].text) as { error_reason: string }).error_reason).toBe('missing_question');
    const noA = await dispatchStudioTool('studio_capture', { type: 'qa', question: 'Q' }, realHost(), qdir);
    expect(noA.isError).toBe(true);
    expect((JSON.parse(noA.content[0].text) as { error_reason: string }).error_reason).toBe('missing_answer');
  });

  it('PIN-4 regression: clip validation through dispatch still holds — missing url → missing_url; missing content → missing_content', async () => {
    const noUrl = await dispatchStudioTool('studio_capture', { type: 'clip', content: 'body' }, realHost(), qdir);
    expect(noUrl.isError).toBe(true);
    expect((JSON.parse(noUrl.content[0].text) as { error_reason: string }).error_reason).toBe('missing_url');
    const noContent = await dispatchStudioTool('studio_capture', { type: 'clip', url: 'https://x.example/p' }, realHost(), qdir);
    expect(noContent.isError).toBe(true);
    expect((JSON.parse(noContent.content[0].text) as { error_reason: string }).error_reason).toBe('missing_content');
  });

  // ── D4/B — capture nav-epoch re-check (the capture-path TOCTOU close, through the real dispatch) ──
  it('PIN-B1 (D4/B core vector): a capture after a nav SINCE the last observe is REFUSED, ZERO rows', async () => {
    // observe established lastObserve=0; an allowed nav bumped current→1; capturing the agent's now-stale
    // content (from the pre-nav page) must be refused — current(1) !== lastObserve(0). Routed through the REAL
    // dispatch → handler → captureFromPage path. MUT: remove the current-vs-lastObserve compare → the stale
    // content persists → RED.
    const before = (db.prepare('SELECT COUNT(*) AS n FROM studio_artifacts').get() as { n: number }).n;
    const r = await dispatchStudioTool('studio_capture', { type: 'clip', content: 'A-body', url: 'https://a.example/p' }, realHost(1, 0), qdir);
    expect(r.isError).toBe(true);
    const out = JSON.parse(r.content[0].text) as { error_reason: string; hint: string };
    expect(out.error_reason).toBe('capture_refused');
    expect(out.hint).toMatch(/navigat|re-observe/i); // the nav-epoch refusal, not the credential one
    const after = (db.prepare('SELECT COUNT(*) AS n FROM studio_artifacts').get() as { n: number }).n;
    expect(after).toBe(before); // nothing persisted
  });

  it('PIN-B2 (D4/B happy path): a capture with NO nav since the last observe SUCCEEDS, persisted content_trusted=0', async () => {
    // current(0) === lastObserve(0) ⇒ not stale ⇒ the capture persists (guards against a vacuously-rejecting
    // guard). MUT: make the guard always-abort (unconditional throw / inverted compare) → a fresh capture is
    // wrongly refused → RED.
    const r = await dispatchStudioTool('studio_capture', { type: 'clip', content: 'fresh-body', url: 'https://a.example/p' }, realHost(0, 0), qdir);
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.content[0].text) as { artifact_id: number; inserted: boolean };
    expect(out.inserted).toBe(true);
    expect(rowById(out.artifact_id).content_trusted).toBe(0);
  });

  it('PIN-B3 (D4/B fail-loud): currentNavEpoch is REQUIRED — an unwired host throws, never silently skips the check', async () => {
    // Mirrors credentialContext: the check dep is REQUIRED (no `?.`). An unwired host fails LOUD (a thrown
    // error when the check runs), never silently captures with no nav-epoch guard. MUT: make currentNavEpoch
    // optional (`deps.currentNavEpoch?.()`) + omit it → the capture proceeds with NO check → persists → RED.
    const unwired = createCaptureHandler({
      sessionId: HOST_SESSION_QA, db, enqueue: (j: IndexJobInput) => { jobs.push(j); },
      credentialContext: async () => ({}), lastObserveEpoch: () => 0,
    } as unknown as Parameters<typeof createCaptureHandler>[0]);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM studio_artifacts').get() as { n: number }).n;
    await expect(unwired({ type: 'clip', content: 'b', url: 'https://a.example/p' } as StudioCaptureInput)).rejects.toThrow();
    const after = (db.prepare('SELECT COUNT(*) AS n FROM studio_artifacts').get() as { n: number }).n;
    expect(after).toBe(before); // the unwired check threw before captureFromPage — nothing persisted
  });

  it('PIN-B4 (D4/B leak-free refusal): the nav_epoch_stale refusal carries NO captured content or url', async () => {
    // The refusal surfaces a generic hint — never the page url or the agent-supplied content (itself possibly
    // page-derived). MUT: include input.url (or input.content) in the refusal hint → RED.
    const SECRET_URL = 'https://a.example/secret-path-9f3a';
    const SECRET_CONTENT = 'STALE_SECRET_BODY_4b2c';
    const r = await dispatchStudioTool('studio_capture', { type: 'clip', content: SECRET_CONTENT, url: SECRET_URL }, realHost(1, 0), qdir);
    expect(r.isError).toBe(true);
    const text = r.content[0].text;
    expect(text).not.toContain(SECRET_URL);
    expect(text).not.toContain(SECRET_CONTENT);
  });
});
