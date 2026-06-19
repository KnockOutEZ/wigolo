import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObserver } from '../../../src/studio/observe.js';
import { StudioEventQueue } from '../../../src/studio/event-queue.js';
import { writeSpill, enforceSpillBudget } from '../../../src/studio/perception/spill.js';
import type { PageSnapshot, SnapshotElement } from '../../../src/studio/perception/snapshot.js';
import type { StudioObserveOutput, StudioToolError } from '../../../src/daemon/studio-dispatch.js';

const el = (ref: string, name: string): SnapshotElement => ({ ref, role: 'button', name });
const mkSnap = (id: string, elements: SnapshotElement[]): PageSnapshot => ({ id, elements, tokenCount: 1, overBudget: false, domTruncated: false, refMap: new Map(), groupByRef: new Map(), domParent: new Map() });
const isErr = (r: StudioObserveOutput | StudioToolError): r is StudioToolError => 'error_reason' in r;
const ok = (r: StudioObserveOutput | StudioToolError): StudioObserveOutput => { if (isErr(r)) throw new Error('expected ok, got ' + r.error_reason); return r; };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wigolo-observe-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const observer = (snapshot: () => Promise<PageSnapshot>, q: StudioEventQueue, over = { inlineBudget: 100000, spillMaxBytes: 10_000_000 }) =>
  createObserver({ snapshot, eventQueue: q, inlineBudget: over.inlineBudget, spillMaxBytes: over.spillMaxBytes, dataDir: dir, maxStableRetries: 3 });

describe('createObserver — atomic, bounded capture + coherent events', () => {
  it('stable page: one capture, full snapshot on first observe', async () => {
    const obs = observer(async () => mkSnap('s1', [el('e1', 'A')]), new StudioEventQueue(100));
    const r = ok(await obs({}));
    expect(r.kind).toBe('full');
    expect(r.id).toBe('s1');
  });

  it('CHURNING page never settles → BOUNDED give-up to a full resync, does NOT livelock', async () => {
    const q = new StudioEventQueue(100);
    let snaps = 0;
    // every snapshot enqueues an event → the cursor changes during each capture → never "stable"
    const obs = observer(async () => { q.enqueue({ type: 'tick' }); return mkSnap('s' + ++snaps, [el('e1', 'A')]); }, q);
    const r = ok(await obs({}));
    expect(snaps).toBe(3); // capped at maxStableRetries — not infinite
    expect(r.kind).toBe('full'); // churn → full resync (the coherent fallback)
  });

  it('coherence: a drained navigation forces a FULL snapshot, with the cursor advanced past it', async () => {
    const q = new StudioEventQueue(100);
    q.enqueue({ type: 'navigation', url: 'https://x.example' });
    const obs = observer(async () => mkSnap('s1', [el('e1', 'A')]), q);
    const r = ok(await obs({ since: 0 }));
    expect(r.events.map((e) => e.type)).toContain('navigation');
    expect(r.kind).toBe('full'); // navigated → full
    expect(r.eventCursor).toBe(1);
  });

  it('diff on a matching base with no navigation; cursor acks delivered events', async () => {
    const q = new StudioEventQueue(100);
    const snaps = [mkSnap('s1', [el('e1', 'A')]), mkSnap('s2', [el('e1', 'A'), el('e2', 'B')])];
    let i = 0;
    const obs = observer(async () => snaps[i++], q);
    const r1 = ok(await obs({}));
    expect(r1.kind).toBe('full');
    const r2 = ok(await obs({ base_id: r1.id }));
    expect(r2.kind).toBe('diff');
  });

  it('a dropped-overflow gap forces a full resync (like a diff base-mismatch)', async () => {
    const q = new StudioEventQueue(2);
    const snaps = [mkSnap('s1', [el('e1', 'A')]), mkSnap('s2', [el('e1', 'A')])];
    let i = 0;
    const obs = observer(async () => snaps[i++], q);
    const r1 = ok(await obs({})); // first → full, drains the (empty) queue
    for (let k = 0; k < 5; k++) q.enqueue({ type: 'comment', k }); // NOW overflow the cap-2 queue → drops 3
    const r2 = ok(await obs({ base_id: r1.id })); // matching base would diff, but the drop forces full
    expect(r2.eventsDropped).toBeGreaterThan(0);
    expect(r2.kind).toBe('full');
  });
});

describe('createObserver — spill drives GC; spill is host-retrievable; evicted → typed error', () => {
  it('over budget → snapshotRef; a follow-up snapshot_ref fetch returns the FULL set (route-to-host)', async () => {
    const big = Array.from({ length: 50 }, (_, i) => el('e' + i, 'Item ' + i));
    const obs = observer(async () => mkSnap('s1', big), new StudioEventQueue(100), { inlineBudget: 60, spillMaxBytes: 10_000_000 });
    const r = ok(await obs({}));
    expect(r.snapshotRef).toMatch(/^spill:/);
    expect(r.elements!.length).toBeLessThan(50); // inline subset
    const fetched = ok(await obs({ snapshot_ref: r.snapshotRef }));
    expect(fetched.kind).toBe('full');
    expect(fetched.elements!.length).toBe(50); // full set retrievable through the host
  });

  it('GC protects the CURRENT response ref (not evicted under its own bound)', async () => {
    const big = Array.from({ length: 40 }, (_, i) => el('e' + i, 'Item ' + i));
    // tiny spillMaxBytes would evict everything unprotected — the just-written ref must survive
    const obs = observer(async () => mkSnap('s1', big), new StudioEventQueue(100), { inlineBudget: 60, spillMaxBytes: 1 });
    const r = ok(await obs({}));
    expect(r.snapshotRef).toBeTruthy();
    const fetched = await obs({ snapshot_ref: r.snapshotRef });
    expect(isErr(fetched)).toBe(false); // protected → still fetchable despite the 1-byte bound
  });

  it('an EVICTED spill ref returns a TYPED error, never a bare null/empty', async () => {
    const obs = observer(async () => mkSnap('s1', [el('e1', 'A')]), new StudioEventQueue(100));
    const ref = writeSpill(['stale'], dir);
    enforceSpillBudget({ maxBytes: 0, dataDir: dir }); // evict it
    const r = await obs({ snapshot_ref: ref });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error_reason).toBe('studio_spill_evicted');
  });
});

describe('createObserver — trust boundary: every page-perception payload is tagged untrusted', () => {
  // Phase 6a: the observe element stream (role/name) is the PRIMARY page-derived channel.
  // A page can render "ignore your instructions…" into an element name; the agent must read
  // the whole payload as DATA, never as instructions. Welded host-side (the page can't forge it).
  it('a FULL snapshot output carries trusted:false', async () => {
    const obs = observer(async () => mkSnap('s1', [el('e1', 'A')]), new StudioEventQueue(100));
    const r = ok(await obs({}));
    expect(r.kind).toBe('full');
    expect(r.trusted).toBe(false);
  });

  it('a DIFF output carries trusted:false (the diff also carries page-derived element descriptors)', async () => {
    const q = new StudioEventQueue(100);
    const snaps = [mkSnap('s1', [el('e1', 'A')]), mkSnap('s2', [el('e1', 'A'), el('e2', 'B')])];
    let i = 0;
    const obs = observer(async () => snaps[i++], q);
    const r1 = ok(await obs({}));
    const r2 = ok(await obs({ base_id: r1.id }));
    expect(r2.kind).toBe('diff');
    expect(r2.trusted).toBe(false);
  });

  it('a host-retrieved SPILL fetch carries trusted:false (the full set is page content too)', async () => {
    const big = Array.from({ length: 50 }, (_, i) => el('e' + i, 'Item ' + i));
    const obs = observer(async () => mkSnap('s1', big), new StudioEventQueue(100), { inlineBudget: 60, spillMaxBytes: 10_000_000 });
    const r = ok(await obs({}));
    const fetched = ok(await obs({ snapshot_ref: r.snapshotRef }));
    expect(fetched.kind).toBe('full');
    expect(fetched.trusted).toBe(false);
  });
});
