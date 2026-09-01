/**
 * The run's driver-side page snapshot — the one held BETWEEN calls, and the one place it can
 * be read (SD2 mini-spec §5; §7 row 1: "human edits a page mid-run → invalidate the snapshot;
 * next result says `page changed by human — re-read`").
 *
 * WHY A HOLDER AND NOT A FIELD: every consumer of a held snapshot (the observe diff base, an
 * act targeting a ref minted from it) used to read its own variable, so "is it stale?" was a
 * question each caller could forget to ask. Here staleness is decided INSIDE `read()` and the
 * stale `PageSnapshot` is simply not reachable through any accessor — a caller that ignores
 * the verdict has nothing to serve. That is the AC's "structurally impossible", not a rule.
 *
 * ATTRIBUTION, NOT DIFFING (§5, pinned A-51-8): the trigger is which INPUT PATH the change
 * arrived on, never a comparison of two DOMs. Agent input is only deliverable through the
 * epoch-fenced `SessionController.dispatchAgentUnit`; human input is everything else and
 * arrives here through `humanEdit`. So an agent act cannot trip this even in principle — it
 * never calls the method — and the page's own JS drift (a ticking feed) is *staleness*,
 * signalled by the settle-diff, not a human edit.
 */
import type { PageSnapshot } from './snapshot.js';
import type { RunEventInput } from '../run-store.js';

/** §7 row 1's words, verbatim. Every surface that announces the invalidation quotes this constant. */
export const PAGE_CHANGED_BY_HUMAN = 'page changed by human — re-read';

export type SnapshotInvalidationCause = 'input' | 'navigation';

/**
 * The page-mutating human input shapes §5 enumerates: "a keystroke run, click, paste, form
 * change, or human-initiated navigation". The list IS the trigger's definition — an input that
 * mutates nothing (mouse move, hover, scroll, focus, a selection drag) is deliberately absent,
 * because announcing "the page changed" on a mouse move would spend the agent's context on
 * noise and teach it to ignore the line that matters.
 */
export const HUMAN_EDIT_KINDS = ['key', 'click', 'paste', 'form_change', 'navigation'] as const;
export type HumanEditKind = (typeof HUMAN_EDIT_KINDS)[number];

const CAUSE_BY_KIND: Readonly<Record<HumanEditKind, SnapshotInvalidationCause>> = {
  key: 'input',
  click: 'input',
  paste: 'input',
  form_change: 'input',
  navigation: 'navigation',
};

/** Wire coercion: the app's input sink hands us a string over IPC, so the kind is untrusted until checked. */
export function isHumanEditKind(value: unknown): value is HumanEditKind {
  return typeof value === 'string' && (HUMAN_EDIT_KINDS as readonly string[]).includes(value);
}

export interface SnapshotInvalidation {
  by: 'human';
  cause: SnapshotInvalidationCause;
  /** Which of §5's shapes landed — kept for the audit; the run event publishes only `cause`. */
  kind: HumanEditKind;
  tabId?: string;
}

/** The seam's whole vocabulary. There is no variant that carries a snapshot the human has since edited. */
export type HeldSnapshotRead =
  | { state: 'none' }
  | { state: 'live'; snapshot: PageSnapshot }
  | { state: 'invalidated'; invalidation: SnapshotInvalidation };

export interface HeldSnapshotOptions {
  /** The tab this holder perceives, when the caller is tab-scoped — rides the run event (law 4's address). */
  tabId?: string;
  /**
   * Fires once per invalidation (never on a repeat while already stale). The wiring binds it to the
   * run log: `appendRunEventWithTail(db, runId, snapshotInvalidatedEvent(i))`, which puts the event
   * on the SSE tail. Kept as a callback so this module owns no database and no run identity.
   */
  onInvalidated?: (invalidation: SnapshotInvalidation) => void;
}

export class HeldSnapshot {
  private snapshot: PageSnapshot | null = null;
  /** Monotonic ticks. §4.2 phrases the condition as "an invalidation newer than the driver's last read". */
  private tick = 0;
  private heldAt = 0;
  private invalidatedAt = 0;
  private invalidation: SnapshotInvalidation | null = null;

  constructor(private readonly opts: HeldSnapshotOptions = {}) {}

  /**
   * THE read seam. Returns the verdict, and the snapshot ONLY when it is still the page the agent
   * last read. Callers branch on `state`; none of them can reach a stale snapshot.
   */
  read(): HeldSnapshotRead {
    if (this.invalidation && this.invalidatedAt > this.heldAt) {
      return { state: 'invalidated', invalidation: this.invalidation };
    }
    return this.snapshot ? { state: 'live', snapshot: this.snapshot } : { state: 'none' };
  }

  /**
   * Record a fresh page read. This — and only this — clears a pending invalidation: the agent
   * re-reading the page is exactly what makes "re-read" satisfied.
   */
  hold(snapshot: PageSnapshot): void {
    this.snapshot = snapshot;
    this.heldAt = ++this.tick;
    this.invalidation = null;
  }

  /**
   * A page-mutating human input landed on this tab. Returns the invalidation it caused, or `null`
   * when there was nothing live to invalidate (no snapshot held yet, or already stale) — so the
   * caller can tell "announced" from "nothing to say" without reading private state.
   */
  humanEdit(kind: HumanEditKind): SnapshotInvalidation | null {
    if (!this.snapshot) return null; // §5: the trigger fires only while a snapshot of this tab is LIVE
    if (this.invalidatedAt > this.heldAt) return null; // already stale — "re-read" is already pending
    this.invalidatedAt = ++this.tick;
    const invalidation: SnapshotInvalidation = {
      by: 'human',
      cause: CAUSE_BY_KIND[kind],
      kind,
      ...(this.opts.tabId !== undefined ? { tabId: this.opts.tabId } : {}),
    };
    this.invalidation = invalidation;
    // A sink that throws must not unwind into the input path: the human's keystroke has already
    // landed on the real page, so the invalidation is a FACT here — refusing to record it would
    // be the one outcome that leaves us serving a snapshot we know is stale.
    try {
      this.opts.onInvalidated?.(invalidation);
    } catch {
      /* recorded regardless — see above */
    }
    return invalidation;
  }

  /** `humanEdit` for an untrusted wire string; an unrecognised shape is ignored, never guessed at. */
  humanEditFromWire(kind: unknown): SnapshotInvalidation | null {
    return isHumanEditKind(kind) ? this.humanEdit(kind) : null;
  }
}

/**
 * The run-log envelope for an invalidation (§5: `snapshot.invalidated { tabId, by, cause }` — a new
 * namespace on the existing envelope). A pure projection so the store, the SSE tail and the audit
 * all see one shape; `kind` stays host-side (the log publishes the cause, not the keystroke).
 */
export function snapshotInvalidatedEvent(invalidation: SnapshotInvalidation): RunEventInput {
  return {
    actor: { kind: 'human' },
    type: 'snapshot.invalidated',
    payload: {
      ...(invalidation.tabId !== undefined ? { tabId: invalidation.tabId } : {}),
      by: invalidation.by,
      cause: invalidation.cause,
    },
  };
}
