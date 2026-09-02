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
import { resolveObserve, type SnapshotDiff } from './perception/diff.js';
import { fitElementsToBudget, fitDiffToBudget, readSpill, enforceSpillBudget } from './perception/spill.js';
import type { PageSnapshot, SnapshotElement } from './perception/snapshot.js';
import { HeldSnapshot, PAGE_CHANGED_BY_HUMAN } from './perception/held-snapshot.js';
import type { StudioEventQueue } from './event-queue.js';
import type { StudioObserveInput, StudioObserveOutput, StudioToolError } from '../daemon/studio-dispatch.js';
import { isCredentialContext } from './credential.js';
import type { LoginHandoffSignal } from './handoff.js';
import { UNTRUSTED_STUDIO_NOTICE, neutralizeMarkers } from '../security/untrusted.js';
import { excerptToFile } from '../server/large-output.js';

/**
 * D8b structural containment for the studio_observe sink: neutralize the untrusted-data boundary marker
 * in a page-derived element's DISPLAY-TEXT fields (role/name) so a hostile name cannot FORGE the fence the
 * untrusted_notice describes. Operational fields (ref, confidence) pass through RAW — the agent targets by
 * ref. Returns a NEW element so the stored snapshot stays raw (future diffs compare raw-vs-raw).
 */
const neutralizeElement = (e: SnapshotElement): SnapshotElement => ({
  ...e,
  role: neutralizeMarkers(e.role),
  name: neutralizeMarkers(e.name),
});

/** D8b: neutralize the display text on every element descriptor a diff carries (added/removed/changed + churn). */
const neutralizeDiff = (d: SnapshotDiff): SnapshotDiff => ({
  ...d,
  added: d.added.map(neutralizeElement),
  removed: d.removed.map(neutralizeElement),
  changed: d.changed.map(neutralizeElement),
  lowConfidenceChurn: {
    ...d.lowConfidenceChurn,
    added: d.lowConfidenceChurn.added.map(neutralizeElement),
    removed: d.lowConfidenceChurn.removed.map(neutralizeElement),
  },
});

/**
 * PIN 8 — GREP-OVER-THE-PAGE RIDES `studio_observe` AS A `find` PARAM.
 *
 * The brief pins the shape as well as the feature: a grep is not worth a new MCP tool (that register
 * is ~11–13 seams including five instruction test files), and it is not worth an act verb either,
 * because it reads rather than drives. It is a parameter on the read tool, and the tool description
 * names it so the agent can find it.
 *
 * It searches the LIVE page's element descriptors — `role` and `name` — not the diff, so the answer
 * is "what is on the page now", the same question a person asking "where is the checkout button"
 * means. That is deliberately narrower than a full-text grep: the perception layer builds its
 * snapshot from the accessibility tree, so non-interactive prose is not in scope here, and saying so
 * in the schema is cheaper than a second CDP read on every observe.
 */
export interface ObserveFindInput {
  /** Substring (default) or regular expression to match against each element's role + name. */
  find?: string;
  /** Treat `find` as a regular expression rather than a literal substring. */
  find_regex?: boolean;
}

/** The find sub-result. Page-derived, so it inherits the payload's `trusted: false` + notice. */
export interface ObserveFindResult {
  query: string;
  regex: boolean;
  /** Total matches on the live page — the count is the whole set, even when the sample is an excerpt. */
  matches: number;
  /** Neutralized matching descriptors, capped. */
  sample: SnapshotElement[];
  /** Matches that are only in `file`. */
  spilled?: number;
  /** Absolute path to every match on disk (law 11). Absent when the sample is the whole set. */
  file?: string;
}

/** Matches kept inline before the rest goes to a file. A grep wants breadth, so this is wider than act's. */
const FIND_INLINE_LIMIT = 20;
/**
 * Longest accepted pattern. A caller-supplied regular expression runs on the host's CPU, so the input
 * is bounded rather than trusted: a short pattern cannot express the nested-quantifier shapes that
 * make catastrophic backtracking expensive, and a long one is refused instead of being run.
 */
const FIND_PATTERN_MAX = 200;

/** Compile the caller's query into a predicate, or return the typed refusal to surface. */
function findMatcher(input: ObserveFindInput): ((e: SnapshotElement) => boolean) | StudioToolError {
  const query = input.find ?? '';
  if (query.length > FIND_PATTERN_MAX) {
    return {
      error_reason: 'find_pattern_too_long',
      error: `find accepts at most ${FIND_PATTERN_MAX} characters; this pattern is ${query.length}.`,
      hint: 'Search for a shorter distinctive fragment, then narrow with a second find.',
    };
  }
  if (!input.find_regex) {
    const needle = query.toLowerCase();
    return (e) => `${e.role} ${e.name}`.toLowerCase().includes(needle);
  }
  let re: RegExp;
  try {
    re = new RegExp(query, 'i');
  } catch (err) {
    return {
      error_reason: 'find_pattern_invalid',
      error: `find_regex was set but the pattern does not compile: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'Fix the expression, or drop find_regex to search for the text literally.',
    };
  }
  return (e) => re.test(`${e.role} ${e.name}`);
}

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
  /**
   * Slice 5e-a: the current login_handoff signal (pulled fresh each observe) — in_progress while
   * a login wall is being handled (the agent waits, does not retry), or the settled completed/failed.
   * Carries ONLY the state, never page content or storageState. Null ⇒ no active handoff ⇒ no field.
   */
  handoffSignal?: () => LoginHandoffSignal | null;
  /**
   * D4/A: called when a REAL page-read completes (a full/diff snapshot of the live page) — refreshes the
   * session lastObserveEpoch so the capture re-check (D4/B) knows the agent has seen the current page. NOT
   * called on spill-retrieval or the credential-context exclusion (neither is a fresh read of the current page).
   */
  markObserved?: () => void;
  /** Observability: attribute the inline payload's token count to the session (read-only gauge source). */
  recordTokens?: (n: number) => void;
  /**
   * §7 row 1: the session's held page snapshot — the diff base, behind the one seam that decides
   * whether a human has since edited it. Supply the SESSION's holder so the human-input trigger and
   * the act path see the same staleness; when absent the observer keeps a private one, so a host
   * that wires nothing still cannot diff against a base a human has touched.
   */
  held?: HeldSnapshot;
  /**
   * Pin 8: run attribution for the file an oversized `find` writes (law 1). Pull-at-eval, matching the
   * other deps here; absent ⇒ the file lands under `unattributed`, which is visible in the path rather
   * than silently pooled.
   */
  runId?: () => string | undefined;
}

/** Build the observe closure. Holds the per-session snapshot for diffing; otherwise stateless. */
export function createObserver(
  deps: ObserverDeps,
): (input: StudioObserveInput & ObserveFindInput) => Promise<(StudioObserveOutput & { found?: ObserveFindResult }) | StudioToolError> {
  const held = deps.held ?? new HeldSnapshot();
  const maxTries = deps.maxStableRetries ?? 3;

  return async (
    input: StudioObserveInput & ObserveFindInput,
  ): Promise<(StudioObserveOutput & { found?: ObserveFindResult }) | StudioToolError> => {
    // Spill retrieval (route-to-host): the spill dir is host-local, so a stdio agent
    // fetches a ref by calling studio_observe({snapshot_ref}), which proxies here.
    if (input.snapshot_ref) {
      const content = readSpill(input.snapshot_ref, deps.dataDir);
      if (content === null) {
        return { error_reason: 'studio_spill_evicted', hint: 'That spilled snapshot is no longer available — re-observe for a fresh one.' };
      }
      // D8b: neutralize the boundary marker in the retrieved set's display text before re-emitting to
      // the agent (an elements spill is an array; an over-budget diff spill is the diff object).
      const restored: unknown = Array.isArray(content)
        ? content.map(neutralizeElement)
        : neutralizeDiff(content as SnapshotDiff);
      return { id: input.base_id ?? '', kind: 'full', trusted: false, untrusted_notice: UNTRUSTED_STUDIO_NOTICE, elements: restored as SnapshotElement[], events: [], eventCursor: input.since ?? 0, eventsDropped: 0, domTruncated: false };
    }

    // §7 row 1's announcement, BEFORE the capture below reads the queue cursor — so the cursor this
    // response returns covers the notice and the agent acks it like any other event. It is a HUMAN
    // event, which is what this queue is for, so it inherits the cursor-ack discipline rather than
    // needing its own: a lost observe response replays it, and an overflow that dropped it would
    // also raise `eventsDropped`, which already forces a full resync. `takeAnnouncement` hands it
    // over once per invalidation, so the credential short-circuit below — which returns before the
    // drain, deliberately without advancing the cursor — parks the notice in the queue rather than
    // re-minting it next turn. (A spill fetch never gets here at all: it is not a page read.) It
    // carries the invalidation's SHAPE and none of the human's content — the fresh snapshot does that.
    const announce = held.takeAnnouncement();
    if (announce) {
      deps.eventQueue.enqueue({ type: 'page_changed', by: announce.by, cause: announce.cause, notice: PAGE_CHANGED_BY_HUMAN });
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
    // Slice 5e-a: the login_handoff signal rides every live observe (pulled fresh) so the agent
    // learns to wait (in_progress) or that the handoff settled — on the credential short-circuit
    // (the handoff window IS a credential context) AND the normal path (the completed settle, by
    // then off the credential screen). Carries only {state}, never content/storageState.
    const handoff = deps.handoffSignal?.() ?? null;

    if (isCredentialContext({ pageUrl: deps.currentUrl?.(), fields: snap.domByRef?.values() })) {
      return {
        id: snap.id,
        kind: 'full',
        trusted: false,
        untrusted_notice: UNTRUSTED_STUDIO_NOTICE,
        credentialContext: true,
        elements: [],
        events: [],
        eventCursor: input.since ?? 0,
        eventsDropped: 0,
        domTruncated: false,
        ...(handoff ? { login_handoff: handoff } : {}),
      };
    }

    // §7 row 1: read the held base through its ONE seam. An `invalidated` verdict yields no
    // snapshot at all, so `resolveObserve` gets a null base and answers `full` — a delta against
    // the page as it was BEFORE the human's edit is not a path this code can take, not a rule it
    // remembers to follow. The verdict is read BEFORE `hold()` below, which is what makes it
    // "an invalidation newer than the driver's last read" (mini-spec §4.2).
    const heldRead = held.read();
    const drained = deps.eventQueue.drainSince(input.since ?? 0);
    // Force a full snapshot (not a delta) on: a navigation, a dropped-overflow gap, or churn give-up.
    const navigated = churned || drained.dropped > 0 || drained.events.some((e) => e.type === 'navigation');
    const resolved = resolveObserve(heldRead.state === 'live' ? heldRead.snapshot : null, snap, { heldBaseId: input.base_id, navigated });
    held.hold(snap);
    // D4/A: a real page-read completed (the credential-exclusion + spill-retrieval paths already returned
    // above) → refresh the session lastObserveEpoch so a later capture knows the agent saw THIS page.
    deps.markObserved?.();

    // Pin 8's `find`, run against the LIVE page rather than the delta: an agent asking "where is the
    // checkout button" wants what is on the page now, not what changed since it last looked. It sits
    // BELOW the credential short-circuit on purpose — that path withholds page content, and a grep is
    // page content — and its matches carry the same neutralization the elements payload carries.
    let found: ObserveFindResult | undefined;
    if (typeof input.find === 'string' && input.find.length > 0) {
      const matcher = findMatcher(input);
      if (typeof matcher !== 'function') return matcher;
      const matches = snap.elements.filter(matcher).map(neutralizeElement);
      const fit = excerptToFile(matches, FIND_INLINE_LIMIT, {
        dataDir: deps.dataDir,
        runId: deps.runId?.(),
        kind: 'find',
      });
      found = {
        query: input.find,
        regex: input.find_regex === true,
        matches: matches.length,
        sample: fit.inline,
        ...(fit.file ? { spilled: fit.spilled, file: fit.file } : {}),
      };
    }

    const base = {
      id: snap.id,
      trusted: false as const, // page-perception payload (elements/diff) is untrusted page data — host-set, not page-forgeable
      untrusted_notice: UNTRUSTED_STUDIO_NOTICE, // P6-a: instruction-channel statement, emitted unconditionally
      events: drained.events,
      eventCursor: cursor, // advanced to the captured instant — gap events are acked, never replayed
      eventsDropped: drained.dropped,
      domTruncated: snap.domTruncated,
      ...(handoff ? { login_handoff: handoff } : {}),
    };

    if (resolved.kind === 'full') {
      const fit = fitElementsToBudget(resolved.snapshot.elements, deps.inlineBudget, deps.dataDir);
      deps.recordTokens?.(fit.tokenCount);
      enforceSpillBudget({ maxBytes: deps.spillMaxBytes, protect: new Set(fit.spillRef ? [fit.spillRef] : []), dataDir: deps.dataDir });
      return { ...base, kind: 'full', elements: fit.elements.map(neutralizeElement), ...(fit.spillRef ? { snapshotRef: fit.spillRef } : {}), ...(found ? { found } : {}) };
    }

    const fitD = fitDiffToBudget(resolved.diff, deps.inlineBudget, deps.dataDir);
    deps.recordTokens?.(fitD.tokenCount);
    enforceSpillBudget({ maxBytes: deps.spillMaxBytes, protect: new Set(fitD.spillRef ? [fitD.spillRef] : []), dataDir: deps.dataDir });
    return { ...base, kind: 'diff', diff: fitD.diff ? neutralizeDiff(fitD.diff) : fitD.summary, ...(fitD.spillRef ? { snapshotRef: fitD.spillRef } : {}), ...(found ? { found } : {}) };
  };
}
