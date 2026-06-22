/**
 * The studio_observe orchestration — the host-side logic the thin tool delegates to
 * (kept out of the dispatch/handler). It is the first thing to drive perception +
 * spill/GC in anger, so the carried criteria are exercised here end-to-end:
 *
 *  - ATOMIC capture: the snapshot and the event cursor are taken at ONE instant (no
 *    event may slip between them). A churning page (per-frame timer / live socket)
 *    never settles, so the retry is BOUNDED — on give-up it forces a full snapshot and
 *    advances the cursor to now (events in the gap are delivered this turn and acked,
 *    never replayed/double-counted).
 *  - exactly-once events via the queue cursor; a dropped-overflow forces a full resync.
 *  - fit → spill → reference-aware GC, with the protect set covering the CURRENT
 *    response's spilled ref (full-snapshot OR diff) so the GC can't evict what the
 *    agent is about to fetch.
 *  - spill retrieval routes to the host: studio_observe({snapshot_ref}) reads the
 *    host-local spill; an evicted ref returns a TYPED error, never a bare null.
 */
import { resolveObserve } from './perception/diff.js';
import { fitElementsToBudget, fitDiffToBudget, readSpill, enforceSpillBudget } from './perception/spill.js';
import type { PageSnapshot, SnapshotElement } from './perception/snapshot.js';
import type { StudioEventQueue } from './event-queue.js';
import type { StudioObserveInput, StudioObserveOutput, StudioToolError } from '../daemon/studio-dispatch.js';
import { isCredentialContext } from './credential.js';

export interface ObserverDeps {
  /** Take the live snapshot (the host binds this to sessionBrowser.cdp). */
  snapshot: () => Promise<PageSnapshot>;
  eventQueue: StudioEventQueue;
  /** Token budget for the inline snapshot/diff; over it spills. */
  inlineBudget: number;
  /** Total-byte bound the GC enforces on the spill dir (the caller MUST supply a bounded value). */
  spillMaxBytes: number;
  dataDir?: string;
  /** Atomic-capture retry cap before forcing a full resync (default 3). */
  maxStableRetries?: number;
  /** Slice 5e-0: the live page URL (host-observed) — the hard half of the credential-context check. Optional; absent ⇒ URL contributes nothing (field-present still applies). */
  currentUrl?: () => string | undefined;
}

/** Build the observe closure. Holds per-session `lastSnapshot` for diffing; otherwise stateless. */
export function createObserver(deps: ObserverDeps): (input: StudioObserveInput) => Promise<StudioObserveOutput | StudioToolError> {
  let lastSnapshot: PageSnapshot | null = null;
  const maxTries = deps.maxStableRetries ?? 3;

  return async (input: StudioObserveInput): Promise<StudioObserveOutput | StudioToolError> => {
    // Spill retrieval (route-to-host): the spill dir is host-local, so a stdio agent
    // fetches a ref by calling studio_observe({snapshot_ref}), which proxies here.
    if (input.snapshot_ref) {
      const content = readSpill(input.snapshot_ref, deps.dataDir);
      if (content === null) {
        return { error_reason: 'studio_spill_evicted', hint: 'That spilled snapshot is no longer available — re-observe for a fresh one.' };
      }
      return { id: input.base_id ?? '', kind: 'full', trusted: false, elements: content as SnapshotElement[], events: [], eventCursor: input.since ?? 0, eventsDropped: 0, domTruncated: false };
    }

    // ATOMIC, BOUNDED capture: snapshot + cursor at one instant; give up to a full resync if the page never settles.
    let snap: PageSnapshot;
    let cursor: number;
    let churned = false;
    let tries = 0;
    for (;;) {
      const before = deps.eventQueue.cursor;
      snap = await deps.snapshot();
      const after = deps.eventQueue.cursor;
      if (before === after) {
        cursor = after; // stable: nothing slipped in during the capture
        break;
      }
      if (++tries >= maxTries) {
        cursor = deps.eventQueue.cursor; // bounded give-up: take "now"; the full resync below makes it coherent
        churned = true;
        break;
      }
    }

    // 5e-0: credential-context perception exclusion. The snapshot above was taken HOST-SIDE for
    // detection; if the live page is a credential context, the agent-facing payload EXCLUDES all page
    // a11y content (element names/roles/text — a name can be a displayed secret like a 2FA/recovery
    // code) and returns ONLY the credential-context signal so the agent waits. Events are NOT drained
    // (preserved for after; a content-bearing mark/nav event must not leak either), and lastSnapshot is
    // NOT updated (the credential snapshot never enters a later diff). Mirrors 5b's capture-exclusion.
    if (isCredentialContext({ pageUrl: deps.currentUrl?.(), fields: snap.domByRef?.values() })) {
      return {
        id: snap.id,
        kind: 'full',
        trusted: false,
        credentialContext: true,
        elements: [],
        events: [],
        eventCursor: input.since ?? 0,
        eventsDropped: 0,
        domTruncated: false,
      };
    }

    const drained = deps.eventQueue.drainSince(input.since ?? 0);
    // Force a full snapshot (not a delta) on: a navigation, a dropped-overflow gap, or churn give-up.
    const navigated = churned || drained.dropped > 0 || drained.events.some((e) => e.type === 'navigation');
    const resolved = resolveObserve(lastSnapshot, snap, { heldBaseId: input.base_id, navigated });
    lastSnapshot = snap;

    const base = {
      id: snap.id,
      trusted: false as const, // page-perception payload (elements/diff) is untrusted page data — host-set, not page-forgeable
      events: drained.events,
      eventCursor: cursor, // advanced to the captured instant — gap events are acked, never replayed
      eventsDropped: drained.dropped,
      domTruncated: snap.domTruncated,
    };

    if (resolved.kind === 'full') {
      const fit = fitElementsToBudget(resolved.snapshot.elements, deps.inlineBudget, deps.dataDir);
      enforceSpillBudget({ maxBytes: deps.spillMaxBytes, protect: new Set(fit.spillRef ? [fit.spillRef] : []), dataDir: deps.dataDir });
      return { ...base, kind: 'full', elements: fit.elements, ...(fit.spillRef ? { snapshotRef: fit.spillRef } : {}) };
    }

    const fitD = fitDiffToBudget(resolved.diff, deps.inlineBudget, deps.dataDir);
    enforceSpillBudget({ maxBytes: deps.spillMaxBytes, protect: new Set(fitD.spillRef ? [fitD.spillRef] : []), dataDir: deps.dataDir });
    return { ...base, kind: 'diff', diff: fitD.diff ?? fitD.summary, ...(fitD.spillRef ? { snapshotRef: fitD.spillRef } : {}) };
  };
}
