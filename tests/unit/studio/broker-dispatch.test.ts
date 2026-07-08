import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { IndexJobInput } from '../../../src/embedding/background-queue.js';
import type { ArtifactDelta } from '../../../src/studio/capture/artifacts.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../../src/cache/db.js';
// The P3 broker's PURE dispatch map — no process, tested against a real in-memory DB. Reds until
// createBrokerHandlers exists.
import { createBrokerHandlers } from '../../../src/daemon/studio-db-broker.js';

/**
 * P3 T1 — broker dispatch. The broker runs the SALVAGED capture pipeline + find_similar; these cases
 * prove each RPC method routes correctly AND that the security gates (credential choke on every persist
 * path, nav-epoch TOCTOU, trust-by-construction) survive the broker seam. The Electron host supplies the
 * gate inputs (session id, epochs, credential signal) per call; here we drive them directly.
 */
describe('studio-db-broker — createBrokerHandlers (dispatch, real in-memory DB)', () => {
  const originalEnv = process.env;
  const mockSearchEngine: SearchEngine = { name: 'mock', search: vi.fn().mockResolvedValue([]) };
  const mockRouter = { fetch: vi.fn() } as unknown as SmartRouter;

  let jobs: IndexJobInput[];
  let deltas: ArtifactDelta[];
  let handlers: ReturnType<typeof createBrokerHandlers>;

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    jobs = [];
    deltas = [];
    handlers = createBrokerHandlers({
      db: getDatabase(),
      engines: [mockSearchEngine],
      router: mockRouter,
      backendStatus: undefined,
      enqueue: (j) => { jobs.push(j); },
      onArtifact: (d) => { deltas.push(d); },
    });
  });
  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  const db = () => getDatabase();
  const artifactCount = (): number => (db().prepare('SELECT COUNT(*) AS n FROM studio_artifacts').get() as { n: number }).n;
  const clip = (over: Record<string, unknown> = {}) => ({
    input: { type: 'clip', content: 'Hello world', url: 'https://ex.com/a' },
    sessionId: 's1', currentNavEpoch: 2, lastObserveEpoch: 2, credentialSignal: {}, ...over,
  });

  it('ping → pong', async () => {
    expect(await handlers.ping()).toBe('pong');
  });

  it('capture clip → inserted; a re-capture dedups (inserted:false, no new row)', async () => {
    const a = await handlers.capture(clip());
    expect(a).toMatchObject({ inserted: true });
    expect('artifact_id' in a && a.artifact_id).toBeGreaterThan(0);
    const b = await handlers.capture(clip());
    expect(b).toMatchObject({ inserted: false });
    expect(artifactCount()).toBe(1);
  });

  it('credential — URL arm: a login-URL capture is refused with no row', async () => {
    const r = await handlers.capture(clip({ credentialSignal: { pageUrl: 'https://ex.com/login', fields: [] } }));
    expect(r).toMatchObject({ error_reason: 'capture_refused' });
    expect(artifactCount()).toBe(0);
  });

  it('credential — FIELD arm: a password field on a NON-login URL is refused (independent of URL detection)', async () => {
    const r = await handlers.capture(clip({
      input: { type: 'clip', content: 'x', url: 'https://ex.com/settings' },
      credentialSignal: { pageUrl: 'https://ex.com/settings', fields: [{ tag: 'input', type: 'password' }] },
    }));
    expect(r).toMatchObject({ error_reason: 'capture_refused' });
    expect(artifactCount()).toBe(0);
  });

  it('nav-epoch TOCTOU: current !== lastObserve → refused (stale capture)', async () => {
    const r = await handlers.capture(clip({ currentNavEpoch: 3, lastObserveEpoch: 2 }));
    expect(r).toMatchObject({ error_reason: 'capture_refused' });
    expect(artifactCount()).toBe(0);
  });

  it('a quote-shaped clip under a credential signal is refused at the broker (not only the host)', async () => {
    const r = await handlers.capture(clip({
      input: { type: 'clip', content: '> secret code', url: 'https://ex.com/login' },
      credentialSignal: { pageUrl: 'https://ex.com/login' },
    }));
    expect(r).toMatchObject({ error_reason: 'capture_refused' });
    expect(artifactCount()).toBe(0);
  });

  it('persistMark stores a type=mark row (present via direct SELECT, ABSENT from listArtifacts panel)', async () => {
    const r = await handlers.persistMark({
      sessionId: 's1', url: 'https://ex.com/a',
      target: { role: 'button', name: 'Buy', ancestorPath: 'main>div>button', fingerprint: '{}', attrs: {} },
      credentialSignal: {},
    });
    expect(r.inserted).toBe(true);
    const markRow = db().prepare("SELECT id FROM studio_artifacts WHERE artifact_type='mark' AND session_id='s1'").get() as { id: number } | undefined;
    expect(markRow?.id).toBe(r.id);
    const list = await handlers.listArtifacts({ sessionId: 's1', limit: 50 });
    expect(list.some((a) => a.id === r.id)).toBe(false); // marks route to the Marks panel, not Captures
  });

  it('persistMark REFUSES on a credential signal — the broker has its own defense, not just host ordering', async () => {
    await expect(handlers.persistMark({
      sessionId: 's1', url: 'https://ex.com/login',
      target: { role: 'button', name: 'X', ancestorPath: 'main>button', fingerprint: '{}', attrs: {} },
      credentialSignal: { pageUrl: 'https://ex.com/login' },
    })).rejects.toThrow(/capture refused|credential/i);
    expect(artifactCount()).toBe(0);
  });

  it('persistScreenshot stores a type=screenshot row (present in listArtifacts) with content_trusted=0; dedups on repeat', async () => {
    const p = { sessionId: 's1', url: 'https://ex.com/a', title: 'shot', mediaPath: '/m/x.png', contentHash: 'abc', credentialSignal: {} };
    const a = await handlers.persistScreenshot(p);
    expect(a.inserted).toBe(true);
    const row = db().prepare('SELECT artifact_type, content_trusted FROM studio_artifacts WHERE id=?').get(a.id) as { artifact_type: string; content_trusted: number };
    expect(row.artifact_type).toBe('screenshot');
    expect(row.content_trusted).toBe(0);
    const list = await handlers.listArtifacts({ sessionId: 's1', limit: 50 });
    expect(list.some((x) => x.id === a.id && x.type === 'screenshot')).toBe(true);
    const b = await handlers.persistScreenshot(p);
    expect(b.inserted).toBe(false);
  });

  it('persistScreenshot REFUSES on a credential signal — no row', async () => {
    await expect(handlers.persistScreenshot({
      sessionId: 's1', url: 'https://ex.com/login', title: 't', mediaPath: '/m/y.png', contentHash: 'z', credentialSignal: { pageUrl: 'https://ex.com/login' },
    })).rejects.toThrow(/capture refused|credential/i);
    expect(artifactCount()).toBe(0);
  });

  it('P6 F1: persistExtraction stores a type=extraction row (in listArtifacts) content_trusted=0; dedups on identical rows', async () => {
    const p = { sessionId: 's1', url: 'https://ex.com/plans', columns: ['name', 'price'], rows: [{ name: 'Pro', price: '$20' }], credentialSignal: {} };
    const a = await handlers.persistExtraction(p);
    expect(a.inserted).toBe(true);
    const row = db().prepare('SELECT artifact_type, content_trusted FROM studio_artifacts WHERE id=?').get(a.id) as { artifact_type: string; content_trusted: number };
    expect(row.artifact_type).toBe('extraction');
    expect(row.content_trusted).toBe(0);
    const list = await handlers.listArtifacts({ sessionId: 's1', limit: 50 });
    expect(list.some((x) => x.id === a.id && x.type === 'extraction')).toBe(true);
    const b = await handlers.persistExtraction(p);
    expect(b.inserted).toBe(false);
  });

  it('P6 F1: persistExtraction REFUSES on a credential signal — no row (broker defense, not just host ordering)', async () => {
    await expect(handlers.persistExtraction({
      sessionId: 's1', url: 'https://ex.com/login', columns: ['user'], rows: [{ user: 'a' }], credentialSignal: { pageUrl: 'https://ex.com/login' },
    })).rejects.toThrow(/capture refused|credential/i);
    expect(artifactCount()).toBe(0);
  });

  it('persistSessionFetch stores a session-targeted fetch as a clip (returns CaptureResult)', async () => {
    const r = await handlers.persistSessionFetch({ sessionId: 's1', url: 'https://ex.com/doc', title: 'Doc', markdown: 'fetched body', credentialSignal: {} });
    expect(r.inserted).toBe(true);
    expect(typeof r.id).toBe('number');
  });

  it('persistSessionFetch REFUSES on a credential signal — no row (a session fetch of a login page never persists)', async () => {
    await expect(handlers.persistSessionFetch({ sessionId: 's1', url: 'https://ex.com/login', title: '', markdown: 'secret', credentialSignal: { pageUrl: 'https://ex.com/login' } }))
      .rejects.toThrow(/capture refused|credential/i);
    expect(artifactCount()).toBe(0);
  });

  it('findSimilar (concept, local corpus) returns results without throwing', async () => {
    await handlers.capture(clip());
    const r = await handlers.findSimilar({ input: { concept: 'Hello world', max_results: 5 } });
    expect(r).toBeDefined();
    expect(Array.isArray(r.results)).toBe(true);
    expect(typeof r.method).toBe('string');
  });

  it('onArtifact fires once on a real clip insert, never on a dedup', async () => {
    await handlers.capture(clip());
    await handlers.capture(clip());
    expect(deltas.filter((d) => d.type === 'clip')).toHaveLength(1);
  });

  // ─── P6 F4: audit persistence (append-only, no prune — M2) ───
  const rec = (over: Record<string, unknown> = {}) => ({ action: 'click', epoch: 1, outcome: { ok: true as const }, ...over });

  it('P6 F4: persistAudit inserts an audit row + returns a monotonic seq; a second persist appends (append-only)', async () => {
    const a = await handlers.persistAudit({ sessionId: 's1', entry: rec({ target: { ref: 'r1' } }) });
    expect(a.seq).toBe(1);
    const b = await handlers.persistAudit({ sessionId: 's1', entry: rec({ action: 'type', outcome: { ok: true, charsLanded: 5 } }) });
    expect(b.seq).toBe(2);
    const n = (db().prepare('SELECT COUNT(*) AS n FROM studio_audit WHERE session_id=?').get('s1') as { n: number }).n;
    expect(n).toBe(2);
    const row = db().prepare('SELECT action, target_ref FROM studio_audit WHERE session_id=? AND seq=1').get('s1') as { action: string; target_ref: string };
    expect(row).toEqual({ action: 'click', target_ref: 'r1' });
  });

  it('P6 F4: listAudit returns rows reverse-chronological, bounded by limit, paged by before', async () => {
    for (let i = 0; i < 5; i++) await handlers.persistAudit({ sessionId: 's1', entry: rec({ action: `a${i}` }) });
    const top = await handlers.listAudit({ sessionId: 's1', limit: 2 });
    expect(top.map((r) => r.seq)).toEqual([5, 4]);
    const next = await handlers.listAudit({ sessionId: 's1', limit: 2, before: 4 });
    expect(next.map((r) => r.seq)).toEqual([3, 2]);
    expect(next[0].action).toBe('a2');
  });

  it('P6 F4: listAudit is session-scoped — never bleeds another session', async () => {
    await handlers.persistAudit({ sessionId: 's1', entry: rec() });
    await handlers.persistAudit({ sessionId: 's2', entry: rec() });
    expect(await handlers.listAudit({ sessionId: 's1', limit: 50 })).toHaveLength(1);
    expect(await handlers.listAudit({ sessionId: 's2', limit: 50 })).toHaveLength(1);
  });

  it('P6 F4: audit is append-only — the broker exposes NO update/delete/prune method (M2 sealed)', () => {
    const methods = Object.keys(handlers);
    expect(methods.some((m) => /delete|update|prune|remove|clear/i.test(m))).toBe(false);
    expect(methods).toContain('persistAudit');
    expect(methods).toContain('listAudit');
  });
});
