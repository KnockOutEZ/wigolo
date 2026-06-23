import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObserver } from '../../../src/studio/observe.js';
import { StudioEventQueue } from '../../../src/studio/event-queue.js';
import { writeSpill, enforceSpillBudget } from '../../../src/studio/perception/spill.js';
import { buildSnapshot, type PageSnapshot, type SnapshotElement, type AxNode, type DomNode } from '../../../src/studio/perception/snapshot.js';
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

  it('PIN-A3 (nav-epoch OBSERVE REFRESH): a successful page-read calls markObserved (lastObserveEpoch := current)', async () => {
    // D4/A: studio_observe is the page-read that establishes "the agent has seen the current page", so its
    // completion refreshes lastObserveEpoch. value-flip RED: createObserver ignores the markObserved dep today
    // → observed stays 0. MUT: drop the markObserved() call on the observe completion path → observed 0 → RED.
    let observed = 0;
    const obs = createObserver({
      snapshot: async () => mkSnap('s1', [el('e1', 'A')]),
      eventQueue: new StudioEventQueue(100),
      inlineBudget: 100000,
      spillMaxBytes: 10_000_000,
      dataDir: dir,
      maxStableRetries: 3,
      markObserved: () => { observed++; },
    });
    const r = ok(await obs({}));
    expect(r.kind).toBe('full');
    expect(observed).toBe(1); // a real page-read refreshed lastObserveEpoch
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

describe('createObserver — Slice 5a non-serialization: host-side credential maps never reach the agent', () => {
  it('domByRef / hasCredentialField / true-semantics attrs are EXCLUDED from the agent-facing payload (elements stay {ref,role,name})', async () => {
    // A REAL snapshot WITH a credential field → host-side domByRef + hasCredentialField ARE populated.
    const axNodes: AxNode[] = [{ ignored: false, role: { value: 'textbox' }, name: { value: 'Account secret' }, backendDOMNodeId: 10 }];
    const root: DomNode = {
      backendNodeId: 1,
      localName: 'html',
      children: [{ backendNodeId: 2, localName: 'body', children: [{ backendNodeId: 10, localName: 'input', attributes: ['type', 'password', 'autocomplete', 'current-password'] }] }],
    };
    const snap = buildSnapshot(axNodes, root, { tokenBudget: 100000 });
    // Host-side: the credential semantics DO exist on the snapshot...
    expect(snap.hasCredentialField).toBe(true);
    expect([...(snap.domByRef ?? new Map()).values()].some((s) => s.type === 'password')).toBe(true);

    // ...but the agent-facing observe payload (the serialization boundary, observe.ts) carries NONE of it.
    const r = ok(await observer(async () => snap, new StudioEventQueue(100))({}));
    const wire = JSON.stringify(r); // exactly what crosses to the agent
    expect(wire).not.toContain('domByRef');
    expect(wire).not.toContain('hasCredentialField');
    expect(wire).not.toContain('password'); // neither type="password" nor the autocomplete token "current-password" leaks
    expect(wire).not.toContain('autocomplete');
    const parsed = JSON.parse(wire) as { kind: string; credentialContext?: boolean; elements?: unknown[] };
    // 5e-0 boundary: a credential snapshot is now also a credential CONTEXT, so observe excludes ALL
    // page content (no elements) and returns the credential-context signal. The host-side maps stay
    // absent (the original 5a non-serialization pin); "elements present + maps absent" moves to the
    // 5e-0 non-credential negative control below.
    expect(parsed.credentialContext).toBe(true);
    expect(parsed.elements ?? []).toEqual([]);
  });
});

describe('createObserver — Slice 5e-0 credential-context perception exclusion (the agent READ path)', () => {
  let dir2: string;
  beforeEach(() => { dir2 = mkdtempSync(join(tmpdir(), 'wigolo-observe-5e0-')); });
  afterEach(() => { rmSync(dir2, { recursive: true, force: true }); });

  const credObserver = (snapshot: () => Promise<PageSnapshot>, currentUrl: () => string | undefined) =>
    createObserver({ snapshot, eventQueue: new StudioEventQueue(100), inlineBudget: 100000, spillMaxBytes: 10_000_000, dataDir: dir2, currentUrl });

  it('PRIMARY: a credential page that DISPLAYS a secret (surfaced as an interactive element NAME) → observe EXCLUDES all page content, returns only the credential-context signal', async () => {
    // The displayed secret reaches the agent as an element NAME (the a11y snapshot carries interactive
    // names) — NOT merely a password field's label. A 2FA/recovery code shown as a link/button text is
    // exactly this. The password field makes the page a credential context.
    const axNodes: AxNode[] = [
      { ignored: false, role: { value: 'link' }, name: { value: '123456' }, backendDOMNodeId: 10 }, // the displayed secret, as an element name
      { ignored: false, role: { value: 'textbox' }, name: { value: 'Password' }, backendDOMNodeId: 11 }, // the credential field → credential context
    ];
    const root: DomNode = {
      backendNodeId: 1, localName: 'html',
      children: [{ backendNodeId: 2, localName: 'body', children: [
        { backendNodeId: 10, localName: 'a', attributes: [] },
        { backendNodeId: 11, localName: 'input', attributes: ['type', 'password'] },
      ] }],
    };
    const snap = async () => buildSnapshot(axNodes, root, { tokenBudget: 100000 });
    // Non-vacuity: the secret IS in the raw snapshot's agent-facing elements (so the exclusion has something to remove).
    expect(JSON.stringify((await snap()).elements)).toContain('123456');

    const r = ok(await credObserver(snap, () => 'https://example.com/account')({})); // non-login URL; the password FIELD drives the credential context
    expect(r).toMatchObject({ credentialContext: true });
    const wire = JSON.stringify(r);
    // MUTATION: remove the observe credential-context exclusion → the displayed "123456" + the field names appear in the agent payload → these RED.
    expect(wire, 'the displayed secret is excluded from the agent payload').not.toContain('123456');
    expect(wire, 'field names/labels are excluded too').not.toContain('Password');
  });

  it('NEGATIVE CONTROL: a NON-credential page → normal full observe payload (no over-suppression); host-side maps still excluded', async () => {
    const axNodes: AxNode[] = [{ ignored: false, role: { value: 'link' }, name: { value: 'Dashboard' }, backendDOMNodeId: 10 }];
    const root: DomNode = { backendNodeId: 1, localName: 'html', children: [{ backendNodeId: 2, localName: 'body', children: [{ backendNodeId: 10, localName: 'a', attributes: [] }] }] };
    const r = ok(await credObserver(async () => buildSnapshot(axNodes, root, { tokenBudget: 100000 }), () => 'https://example.com/home')({}));
    expect(r.credentialContext).toBeUndefined(); // not a credential page → not flagged
    const wire = JSON.stringify(r);
    expect(wire, 'normal page content IS delivered').toContain('Dashboard');
    expect(wire).not.toContain('domByRef'); // host-side maps still excluded (5a holds, with elements present)
    expect(wire).not.toContain('hasCredentialField');
  });
});

describe('createObserver — Slice 5e-a login_handoff signal delivery (the agent learns to wait / that it settled)', () => {
  let dir3: string;
  beforeEach(() => { dir3 = mkdtempSync(join(tmpdir(), 'wigolo-observe-5ea-')); });
  afterEach(() => { rmSync(dir3, { recursive: true, force: true }); });

  const obsWithSignal = (
    snapshot: () => Promise<PageSnapshot>,
    handoffSignal: () => { state: 'in_progress' | 'completed' | 'failed'; doNotRetry?: true } | null,
    currentUrl?: () => string | undefined,
  ) =>
    createObserver({ snapshot, eventQueue: new StudioEventQueue(100), inlineBudget: 100000, spillMaxBytes: 10_000_000, dataDir: dir3, handoffSignal, currentUrl });

  it('L-5e0-1: DURING the window (credential context) the signal IS delivered alongside the exclusion — content excluded, login_handoff:in_progress present', async () => {
    // The window page is a credential context (login URL). 5e-0 excludes the content; 5e-a ALSO
    // delivers the login_handoff signal so the agent knows to wait, not retry.
    const r = ok(await obsWithSignal(
      async () => mkSnap('s1', [el('e1', 'A')]),
      () => ({ state: 'in_progress', doNotRetry: true }),
      () => 'https://acme.example/login',
    )({}));
    expect(r.credentialContext).toBe(true);
    expect(r.elements ?? []).toEqual([]); // content still excluded
    // MUTATION (drop the handoff signal from the credential short-circuit) → this reds.
    expect(r.login_handoff).toEqual({ state: 'in_progress', doNotRetry: true });
  });

  it('on a NORMAL page after settle, the login_handoff:completed signal rides the regular payload', async () => {
    const r = ok(await obsWithSignal(
      async () => mkSnap('s1', [el('e1', 'A')]),
      () => ({ state: 'completed' }),
      () => 'https://example.com/home',
    )({}));
    expect(r.credentialContext).toBeUndefined(); // not a credential page
    expect(r.kind).toBe('full');
    expect(r.login_handoff).toEqual({ state: 'completed' }); // the agent learns the handoff settled
  });

  it('no active handoff (signal null) → NO login_handoff field (no over-signaling on a normal observe)', async () => {
    const r = ok(await obsWithSignal(async () => mkSnap('s1', [el('e1', 'A')]), () => null, () => 'https://example.com/home')({}));
    expect(r.login_handoff).toBeUndefined();
  });
});

describe('createObserver — the page-perception payload carries the untrusted-data notice (P6-a)', () => {
  it('a full snapshot result carries a well-formed untrusted-data instruction-channel statement', async () => {
    const r = ok(await observer(async () => mkSnap('s1', [el('e1', 'A')]), new StudioEventQueue(100))({}));
    expect(r.kind).toBe('full');
    expect(typeof r.untrusted_notice).toBe('string');
    expect(r.untrusted_notice).toMatch(/UNTRUSTED DATA/);
    expect(r.untrusted_notice.toLowerCase()).toMatch(/not.*instruction|never.*(follow|obey|execute)/);
  });

  it('the notice is present and IDENTICAL on a credential-context result (never gated on a flag)', async () => {
    const full = ok(await observer(async () => mkSnap('s1', [el('e1', 'A')]), new StudioEventQueue(100))({}));
    const credObs = createObserver({
      snapshot: async () => mkSnap('sC', [el('e1', 'secret-code')]),
      eventQueue: new StudioEventQueue(100),
      inlineBudget: 100000,
      spillMaxBytes: 10_000_000,
      dataDir: dir,
      currentUrl: () => 'https://acme.example/login',
    });
    const cred = ok(await credObs({}));
    expect(cred.credentialContext).toBe(true);
    expect(typeof cred.untrusted_notice).toBe('string');
    expect(cred.untrusted_notice).toBe(full.untrusted_notice); // same statement whether or not it's a credential page
  });
});
