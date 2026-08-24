import { projectRun, type CreateRunInput, type ListRunsOptions, type ListRunsResult, type Run, type RunEvent, type RunEventInput, type StoredRunFacts } from 'wigolo/studio';
import type { BrokerClient } from './broker-client';
import { originOnly } from './url-policy';

/**
 * SD1 spine 1 — the run store is authoritative and this is a projection of it.
 *
 * `SessionRegistry` used to keep session identity, a `tabIds` array and a "current" pointer in Electron
 * main, which made the app a second source of truth for facts that outlive it. The inversion: the daemon
 * store owns run identity and tab membership as an append-only log, and everything here is a replay of
 * that log. There is deliberately no "current run" pointer to mirror the old `currentId`:
 * which run the human is looking at is the owner of the focused TAB, derived where the state push is
 * assembled. A second pointer beside the tab layer is what let the chrome name one run while showing
 * another's page — which is the same class of drift the `tabIds` array was.
 *
 * The one rule the log cannot express by itself is law 4's "a tab belongs to exactly one run" — an append
 * is unconditional, so the refusal has to happen before it. That check lives here, at the single seam
 * every caller goes through, and it is a refusal rather than a reassignment: a silent steal would hand
 * one agent another agent's page.
 */

/**
 * One run's stored facts and the envelopes that project it — what a replay needs, and nothing else.
 *
 * `events` is a BOUNDED read, so it is not always the whole log. When it is not, the store sends
 * `projection` in its place — the answer it computed for the same run by its own bounded path — and
 * this class keeps that instead, the way it keeps a finished run's. `lastSeq` is the store's real
 * tail either way, which is what stops a capped read from looking like a missed envelope.
 */
export interface RunLogEntry {
  facts: StoredRunFacts;
  events: RunEvent[];
  /** The store's true tail seq. Absent only on a store that predates the bound. */
  lastSeq?: number;
  /** A projection sent in place of a log too large for one frame. */
  projection?: Run;
  /** The session link `run.created` carries, when no envelope came with it to replay it from. */
  sessionId?: string;
}

/** A page of the boot listing, with the cursor that continues it. */
export interface RunLogPage {
  entries: RunLogEntry[];
  nextCursor?: string;
}

/** The store, as this process reaches it. Broker-backed in the app; the port exists so tests can bind. */
export interface RunStoreClient {
  createRun(input: CreateRunInput): Promise<Run>;
  appendEvent(runId: string, event: RunEventInput): Promise<RunEvent>;
  getRun(runId: string): Promise<Run | undefined>;
  /**
   * The filter/paging options exist for the REST surface (`GET /v1/runs?status=&limit=&cursor=`),
   * which this process now serves as the live store owner — and for `hydrate`, which pages through
   * the listing rather than taking its first page and stopping.
   */
  listRuns(opts?: ListRunsOptions): Promise<ListRunsResult>;
  /**
   * `limit` is REQUIRED, and it is required here rather than merely honoured: the whole point of the
   * parameter is that no caller can ask this process to accumulate and parse an entire run log in one
   * frame, and an optional one lets a caller ask by saying nothing.
   */
  eventsSince(runId: string, since: number, limit: number): Promise<RunEvent[]>;
  onRunEvent(handler: (runId: string, event: RunEvent) => void): void;
  /**
   * The whole boot page — facts and events together — in one round-trip, rather than a listing
   * followed by a read per run. Optional because this is a port: a store that does not offer it is
   * still correct, and `hydrate` falls back to the listing plus a concurrent read per run.
   */
  listRunLogs?(opts?: ListRunsOptions): Promise<RunLogPage>;
  /**
   * Does this run exist, without projecting it? `getRun` replays the whole log to answer, which is
   * what the SSE route's paged replay exists to avoid. Optional for the same reason as `listRunLogs`.
   */
  runExists?(runId: string): Promise<boolean>;
  /**
   * The four stored facts, with no projection behind them. A replay wants the facts and then the log;
   * asking `getRun` for the facts makes the store project the run first and throws the projection
   * away. Optional for the same reason as `listRunLogs`; `getRun` is the fallback.
   */
  runFacts?(runId: string): Promise<StoredRunFacts | undefined>;
}

export function createBrokerRunStoreClient(broker: BrokerClient): RunStoreClient {
  return {
    createRun: (input) => broker.call<Run>('runCreate', { input }),
    appendEvent: (runId, event) => broker.call<RunEvent>('runAppend', { runId, event }),
    getRun: (runId) => broker.call<Run | undefined>('runGet', { runId }),
    listRuns: (opts = {}) => broker.call<ListRunsResult>('runList', opts),
    listRunLogs: (opts = {}) => broker.call<RunLogPage>('runListLogs', opts),
    eventsSince: (runId, since, limit) => broker.call<RunEvent[]>('runEventsSince', { runId, since, limit }),
    runExists: (runId) => broker.call<boolean>('runExists', { runId }),
    runFacts: (runId) => broker.call<StoredRunFacts | undefined>('runFacts', { runId }),
    onRunEvent: (handler) => broker.onRunEvent(handler),
  };
}

function factsOf(run: Run): StoredRunFacts {
  return { id: run.id, task: run.task, spaceId: run.spaceId, createdAt: run.createdAt };
}

export class TabOwnedError extends Error {
  constructor(readonly tabId: string, readonly ownerRunId: string) {
    super(`tab ${tabId} already belongs to run ${ownerRunId}`);
    this.name = 'TabOwnedError';
  }
}

export type TabDetachReason = 'closed' | 'run_ended';
export type RunTerminal = 'completed' | 'failed' | 'cancelled';
/** §8 — where a promote was asked for. Demote carries no surface; only who did it matters. */
export type PromoteSurface = 'tray' | 'chrome' | 'panel';
export type PresentationBy = 'human' | 'system';

const TERMINAL_STATUSES: ReadonlySet<Run['status']> = new Set<Run['status']>(['done', 'failed', 'cancelled']);
/**
 * The event types that make a run terminal. Kept as types rather than derived by projecting, because
 * this is asked on EVERY folded envelope — projecting to find out whether to project would make
 * folding a long run quadratic, which is the class of defect the retention bound exists to remove.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(['run.completed', 'run.failed', 'run.cancelled']);

export function isTerminal(status: Run['status']): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * How long a burst of envelopes may be folded into one fan-out — one frame at 60 Hz.
 *
 * The fan-out is what makes folding expensive, not the fold. Every listener answers by PROJECTING:
 * `ipc-host` pushes `runs.listLive()` at the renderer, `run-tray` rebuilds a native menu template and
 * hands it to the OS item, `run-presentation` reads `listLive()` to decide what the window wants. Each
 * of those refills the memo the fold just dropped, so an un-coalesced fan-out replays the whole log once
 * per envelope: measured on the shipped code at 3k envelopes = 44 ms against 6 ms with nobody
 * watching, and at 20k = 1135 ms against 14 ms — doubling the log roughly quadrupled the cost, on the
 * Electron main thread, which is also the thread that paints.
 *
 * A frame is the bound because nothing downstream can use anything finer: the menu bar, the dock
 * badge and the renderer all redraw at the display's rate at best. Coalescing to it makes the cost of
 * watching a run a function of how long the burst lasts rather than of how many envelopes it carries.
 */
export const EMIT_COALESCE_MS = 16;

/**
 * How many envelopes one `eventsSince` frame carries.
 *
 * A replay used to ask for the whole log — `eventsSince(runId, 0)` with no limit — and the store used
 * to answer that literally: one stdio frame the size of the run, accumulated here as a single JS
 * string and `JSON.parse`d in one synchronous bite, on the thread that paints, on EVERY seq gap. The
 * bound has to be per frame, so a replay pages.
 *
 * Well under the store's own per-frame ceiling, so the page this asks for is the page it gets. It
 * still stops on an EMPTY page rather than a short one, because a short page is exactly what a
 * server-side ceiling looks like from here and stopping on it would silently truncate a log.
 */
const REPLAY_PAGE_SIZE = 500;

/**
 * How many listing pages boot will follow.
 *
 * `hydrate` follows `nextCursor` now, and the loop's exit condition comes from the store, so a
 * binding that returned a cursor forever would spin on the thread that paints. Reaching this means a
 * broken store rather than a large one: it is `DEFAULT_LIST_LIMIT` × this, which is far more runs
 * than any surface here can name.
 */
const MAX_HYDRATION_PAGES = 200;

/**
 * How many envelopes the WHOLE hydration may load and retain — across every page, not per page.
 *
 * The store bounds one boot frame: `runListLogs` spends an event and a character allowance over the
 * runs on its page and answers the rest with projections, so no single frame can stall the thread
 * that paints. That allowance is a LOCAL of the call, and `hydrate` makes up to
 * `MAX_HYDRATION_PAGES` of those calls — so the bound that holds for one frame was being handed out
 * two hundred times, and the ceiling on what boot loads was `MAX_HYDRATION_PAGES ×` it. Nothing
 * evicts afterwards: `retain` holds every entry's envelopes for the process's life, and the listing
 * carries no status filter, so a run that ended months ago was read, parsed and held exactly like a
 * live one.
 *
 * So the allowance is carried across the hydration instead. Once it is spent, the remaining pages
 * are taken from `listRuns` — projections only, no envelopes on the wire at all — which is the same
 * answer the store already gives for a single log too large for one frame, and the same one REST
 * gives for that run. Every reader stays correct, and the run replays in bounded pages when it next
 * speaks.
 *
 * Pinned to the store's own per-frame event allowance, so the two decisions cannot drift into
 * disagreeing about the same boot. That makes the total what one frame used to be, and the shipped
 * bound on what boot retains `MAX_BOOT_HYDRATION_EVENTS` plus at most one page — the page that
 * spends the last of it is finished rather than torn in half, because an entry refused mid-page has
 * no projection to be kept in place of its envelopes.
 *
 * The listing is newest-first, so the allowance is spent on the runs a surface is most likely to
 * name, and the ones answered by projection are the oldest — which are also the ones most likely to
 * be terminal, and a terminal run's envelopes are dropped by `seal` the moment they are folded.
 */
export const MAX_BOOT_HYDRATION_EVENTS = 20_000;

/**
 * How long a log may be before a condensed run is RE-condensed rather than materialized.
 *
 * A run is condensed at boot precisely because it is long, and a live long run is exactly the one
 * that emits next — so the first live envelope used to route through `adopt(replace)` → `replay` →
 * `readLog(runId)` from seq 0, with no total cap, and then `retain` with no projection so nothing
 * condensed it again. One envelope after boot bought back the whole cost the bound had just removed:
 * a hundred sequential broker round-trips, a `JSON.parse` per envelope on the thread that paints, and
 * every envelope retained for the rest of the run's life.
 *
 * So the bound is re-applied here, on the same quantity the store decides it on — `seq` is gap-free
 * and starts at 1, so the tail seq IS the event count — and a run still over it is answered the way
 * boot answered it: with the store's own projection, for one round-trip and a few hundred bytes.
 *
 * A run UNDER it is materialized, because condensing is not only about length: a short run at the end
 * of a full boot page is condensed by the page's budget rather than by its own size, and that one is
 * far better off holding its envelopes and folding the next one for free. Pinned to the store's
 * per-run boot budget so the two decisions cannot drift into disagreeing about the same run.
 */
export const REMATERIALIZE_MAX_EVENTS = 2_000;

/** A memoised projection, plus the moment the clock alone stops it being true. */
interface ProjectionMemo {
  run: Run;
  /**
   * When the earliest pending decision auto-denies, in ms since the epoch — `undefined` when nothing
   * about this projection can move without an event. `projectRun` is a pure function of the log AND
   * the clock, and this is the only field the clock touches, so it is the only thing a memo has to
   * expire on.
   */
  staleAt: number | undefined;
}

/**
 * A sealed run's projection cannot be recomputed — its envelopes are gone by design — but the clock
 * can still move one of its fields. Expiry only ever REMOVES a card and never adds one, so it can be
 * applied to the kept projection directly. Returns the projection unchanged when nothing has expired,
 * so the ordinary read stays free and keeps its identity.
 *
 * The STATUS has to move with the cards, not just the list. Stripping the card and keeping
 * `needs_you` left a condensed live run answering `status: needs_you, pendingDecisions: []` for the
 * rest of its life — one projection contradicting itself, which is the same defect as two surfaces
 * contradicting each other. `needs_you` can also come from a `run.paused` this projection no longer
 * records, so the downgrade is the honest answer only until the horizon timer's re-read lands; see
 * `trackHorizon`, which replays a condensed run from the store rather than leaving it on a guess.
 */
function withoutExpiredDecisions(run: Run, now: Date): Run {
  const at = now.getTime();
  if (!run.pendingDecisions.some((d) => Date.parse(d.autoDenyAt) <= at)) return run;
  const pendingDecisions = run.pendingDecisions.filter((d) => Date.parse(d.autoDenyAt) > at);
  const status = run.status === 'needs_you' && pendingDecisions.length === 0 ? 'running' : run.status;
  return { ...run, pendingDecisions, status };
}

/** A timer that can never be the reason this process stays alive. */
export function unrefTimer(cb: () => void, ms: number): () => void {
  const handle = setTimeout(cb, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
}

/** What a surface needs to name a run. Everything on it is projected; nothing is stored here. */
export interface RunSummary {
  id: string;
  task: string;
  status: Run['status'];
  tabIds: string[];
  visibility: Run['visibility'];
}

/**
 * What a surface shows: everything unfinished, plus anything still being watched so it can be demoted.
 *
 * One rule, in one place, because three listeners answer with it — the state push, the tray menu and
 * the presentation controller — and a surface that narrowed differently would be a second account of
 * which runs exist (law 1). A finished run that is still on screen stays listed: dropping it would
 * leave the human watching a run the chrome no longer knows about, with no affordance left to send it
 * away.
 */
export function isListable(run: Pick<Run, 'status' | 'visibility'>): boolean {
  return !isTerminal(run.status) || run.visibility === 'visible';
}

interface RunLog {
  facts: StoredRunFacts;
  /** The envelopes this projection is folding. Emptied once `kept` is set — see `condense`. */
  events: RunEvent[];
  /**
   * The highest seq the STORE holds, not the highest one folded in. Tracked beside the events rather
   * than read off their tail, because neither a sealed run (whose tail is gone) nor a condensed one
   * (whose log was too large to send) has a tail that says where the store actually is — and both
   * still have to recognise the next live envelope as the next one rather than as a hole.
   */
  lastSeq: number;
  /** Replayed from `run.created` once, rather than searched for on every `runForSession` sweep. */
  sessionId?: string;
  /**
   * A projection kept in place of the events that produced it. Two things set it: sealing a terminal
   * run, whose projection can never move again, and a boot read that found the log too large for one
   * frame and was handed the store's own projection instead. In both cases every reader — `list`,
   * `ownerOf`, `snapshot` — is answered correctly and cheaply, and the next envelope replays.
   */
  kept?: Run;
}

/** A replay in flight, and whether anything asked for another one while it was reading. */
interface AdoptState {
  promise: Promise<void>;
  again: boolean;
}

/** What the store knows about a log that the log itself cannot say once it has been bounded. */
interface RetainOptions {
  /** The store's true tail seq. See `RunLogEntry.lastSeq`. */
  lastSeq?: number;
  /** A projection to keep IN PLACE of envelopes too large to have been sent. */
  projection?: Run;
  /** The session link, when no `run.created` envelope came with the entry to replay it from. */
  sessionId?: string;
}

/** What a caller may say about one hydration. */
export interface HydrateOptions {
  /**
   * The envelope allowance for this hydration, defaulting to `MAX_BOOT_HYDRATION_EVENTS`.
   *
   * Injectable for the same reason `now` and `setTimer` are: the shipped bound is twenty thousand
   * envelopes across the boot, and a test that cannot force it has to ALLOCATE it — which measures
   * how fast the fixture builds rather than what happens at the boundary. The behaviour either side
   * of the line is identical whatever the line is.
   */
  eventBudget?: number;
}

export class RunViewModel {
  /** A replica of each live run's log, refillable at any time from the store. Not a second source of truth. */
  private readonly logs = new Map<string, RunLog>();
  /** Memoised `projectRun` output, dropped whenever a run's events change. A pure function's cache. */
  private readonly projected = new Map<string, ProjectionMemo>();
  /**
   * Law 4's index: which run owns each tab, maintained on the fold rather than searched for.
   *
   * `ownerOf` used to walk every run and project it, and it is asked once per TAB per state push —
   * `ipc-host`'s `state()` labels every tab with its run — so a broadcast cost tabs × runs × the tabs
   * each run holds, on the thread that paints, every time anything moved. The map is not a second
   * source of truth: it is derived from the same envelopes `projectRun` folds, by the same two rules
   * (`tab.attached` adds, `tab.detached` removes only from the run that holds it), and it is rebuilt
   * wholesale from the projection whenever a run's log is replaced.
   */
  private readonly tabOwners = new Map<string, string>();
  /**
   * The same index read the other way: which tabs each run owns.
   *
   * It exists so that DROPPING a run's entries costs what that run holds instead of what the machine
   * holds. `retain` re-indexes the run it just replaced, and `hydrate` calls `retain` once per listed
   * run — up to `MAX_HYDRATION_PAGES × DEFAULT_LIST_LIMIT` of them — so a clear that walked the whole
   * forward map made boot quadratic in the run count on the thread that paints, before the first
   * frame: 10,000 runs × 3 tabs measured 1.3 s of nothing but map deletion.
   *
   * Not a third source of truth either: both directions are written by the same two fold rules, in
   * `ownTab` and `disownTab`, which are the only two places `tabOwners` is mutated.
   */
  private readonly tabsByRun = new Map<string, Set<string>>();
  /**
   * The tail seq at which each condensed run last had a CLOCK-driven re-read issued for it.
   *
   * `withoutExpiredDecisions` infers a status, and a condensed run asks the store for the real one
   * rather than letting the guess stand. Once a run stays condensed across that re-read, asking again
   * at the same tail cannot learn anything the last answer did not carry — and, if the store's clock
   * disagrees about the card by a hair, each answer would narrow again and ask again forever. The
   * tail moving is what makes a new answer possible, so the tail is what re-opens the question.
   */
  private readonly statusRereads = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  /** True while a fan-out window is open — see `emit`. */
  private coalescing = false;
  /** A change that arrived inside an open window and is owed the fan-out that closes it. */
  private coalesced = false;
  /**
   * Replays in flight, so a burst of events for one run causes a single replay — and so a caller that
   * needs the projection current before it resolves can await the replay somebody else started.
   */
  private readonly adopting = new Map<string, AdoptState>();
  /** One presentation transition at a time per run — see `setVisibility`. */
  private readonly transitions = new Map<string, Promise<void>>();
  /** One ownership change at a time per TAB — see `queueForTab`. */
  private readonly tabOps = new Map<string, Promise<unknown>>();
  /** The scheduled fan-out for each run's earliest auto-deny — see `trackHorizon`. */
  private readonly horizons = new Map<string, { at: number; stop: () => void }>();
  /** How to cancel the open coalescing window, while one is open — see `emit` and `dispose`. */
  private closeWindow: (() => void) | undefined;

  /**
   * `now` is injectable for the same reason `projectRun` takes one: the projection depends on the
   * wall clock through `autoDenyAt`, so a test that cannot move the clock cannot reach the state
   * where a pending decision has expired without any event arriving to say so. `setTimer` is
   * injectable for the same reason again: the fan-out AT that moment is on a real two-minute timer,
   * and a test that cannot drive it cannot observe the transition it exists to announce.
   */
  constructor(
    private readonly store: RunStoreClient,
    private readonly now: () => Date = () => new Date(),
    private readonly setTimer: (cb: () => void, ms: number) => () => void = unrefTimer,
  ) {
    this.store.onRunEvent((runId, event) => this.applyEvent(runId, event));
  }

  /**
   * Let go of every scheduled timer. One that outlives the app would fan out into a dead window.
   *
   * The coalescing window counts, and it is the likelier of the two: shutdown ENDS every live run, so
   * the last thing that happens before this call is a burst of terminal appends, and whichever of them
   * lands in the final 16 ms is owed a trailing fan-out. The tray is destroyed one line earlier, so
   * that fan-out would reach a destroyed OS item — the same failure the ordering above exists to avoid,
   * arriving a frame late. A horizon is on the injected timer and was already released here; the window
   * was on a raw `setTimeout` that nothing held a handle to, so it could not be.
   */
  dispose(): void {
    for (const { stop } of this.horizons.values()) stop();
    this.horizons.clear();
    this.closeWindow?.();
    this.closeWindow = undefined;
    this.coalescing = false;
    this.coalesced = false;
  }

  /**
   * Fires whenever the projection moves. The tab strip needs this on top of `TabManager.onChange`:
   * detaching is an async append, so a tab closing and its run releasing it are two separate moments
   * and only the second one carries the new ownership.
   */
  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  /**
   * Announce that the projection moved, at most once per frame.
   *
   * Leading edge FIRST, then a closed window: a single change still reaches the menu bar and the
   * renderer in the same turn it happened — latency is the reason a chat surface exists — while
   * everything that lands inside the window is folded into the one fan-out that closes it. A
   * trailing-only debounce would have bought the same bound at the price of making every isolated
   * change a frame late, which is a worse trade for a surface a human is looking at.
   *
   * A microtask debounce was not enough: the store fans each committed envelope out before its own
   * append resolves, so a stream of appends puts a promise turn between every fold and drains a
   * microtask queue between each one. The window has to be a real one.
   *
   * A change with NO listener is dropped rather than remembered, because it is not observable and
   * nothing can have missed it: every subscriber seeds itself where it subscribes — the tray redraws
   * on mount, the presentation controller applies on reconcile, the renderer pulls `getState`.
   */
  private emit(): void {
    if (this.listeners.size === 0) return;
    if (this.coalescing) { this.coalesced = true; return; }
    this.coalescing = true;
    this.fanOut();
    // The INJECTED timer, and a handle kept for `dispose`. A raw `setTimeout` here was neither: it
    // could not be cancelled at shutdown, so a change landing in the last frame fanned out into
    // mid-teardown listeners, and it kept a ref on the loop that no test could drive either.
    this.closeWindow = this.setTimer(() => {
      this.closeWindow = undefined;
      this.coalescing = false;
      if (!this.coalesced) return;
      this.coalesced = false;
      this.emit();
    }, EMIT_COALESCE_MS);
  }

  /**
   * Every listener gets the fan-out, whatever the one before it did.
   *
   * A bare loop made one listener's throw two separate defects. It reached the CALLER — `emit` is
   * called from `applyEvent`, which is the broker's live-tail callback, so the throw left the fold as
   * an uncaught exception in the Electron main and took the tray's process down with it — and it
   * starved every listener after it of a fold that had already committed: the state push, the menu
   * template and the presentation controller are three subscribers to one event, and the second one
   * throwing left the third holding a projection the log has already moved past, with nothing to
   * re-fire it. Neither is recoverable afterwards, because a fan-out is not replayed.
   *
   * Same rule and same reason as `publishRunEvent` on the core side. The copy is part of it: a
   * listener that subscribes another one while the fold is being announced must not extend the pass
   * that is announcing it.
   */
  private fanOut(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (err) {
        // stderr, never stdout — stdout is the MCP frame channel. Loud rather than swallowed: a
        // listener that throws is a bug in a surface, and the only place it can now be seen.
        process.stderr.write(`[studio] a run-projection listener threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      }
    }
  }

  /**
   * Replay every run from the store. Safe to call repeatedly — it replaces what it holds.
   *
   * A run the listing did not name is KEPT rather than dropped: the listing is a snapshot, and a run
   * created after it was taken would otherwise be discarded here and stay invisible until it happened
   * to emit again. Runs are never deleted, so "absent from the listing" only ever means "newer than it".
   */
  async hydrate(opts: HydrateOptions = {}): Promise<void> {
    let cursor: string | undefined;
    // The allowance for the WHOLE hydration, not for each page — see `MAX_BOOT_HYDRATION_EVENTS`.
    let eventsLeft = opts.eventBudget ?? MAX_BOOT_HYDRATION_EVENTS;
    // EVERY page, not the first one. This called `loadLogs()` with no options, which takes
    // `DEFAULT_LIST_LIMIT` runs and drops the `nextCursor` the store hands back with them — so a
    // machine with fifty-one runs booted the app showing fifty, and the fifty-first stayed invisible
    // until it happened to emit, because nothing calls `hydrate` after boot.
    for (let page = 0; page < MAX_HYDRATION_PAGES; page++) {
      const pageOpts = cursor ? { cursor } : {};
      const nextCursor =
        eventsLeft > 0 ? await this.hydrateLogPage(pageOpts, (n) => { eventsLeft -= n; }) : await this.hydrateProjectionPage(pageOpts);
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    this.emit();
  }

  /** One boot page WITH envelopes, charging what it retained against the hydration's allowance. */
  private async hydrateLogPage(opts: ListRunsOptions, charge: (events: number) => void): Promise<string | undefined> {
    const { entries, nextCursor } = await this.loadLogs(opts);
    for (const entry of entries) {
      charge(entry.events.length);
      this.retain(entry.facts, entry.events, entry);
    }
    return nextCursor;
  }

  /**
   * One boot page as PROJECTIONS — the shape every page takes once the allowance is spent.
   *
   * `listRuns` rather than `listRunLogs`, so the envelopes never cross the pipe and are never parsed:
   * skipping the retention alone would still have paid the frame, and the frame is what blocks the
   * thread that paints. Kept exactly the way the store's own condensed entry is kept, which is what
   * makes this a bound on cost and not a second account of which runs exist.
   *
   * KNOWN COST: `listRuns` answers with projections, and a projection cannot carry the session link —
   * only the `run.created` envelope does, which is why the store reads it separately for the entries
   * IT condenses. A run answered here is therefore invisible to `runForSession` until it next speaks.
   * Accepted because reaching this page at all means twenty thousand envelopes are newer than the run,
   * and because the alternative is a round-trip per run, which is the boot cost this whole path exists
   * to remove. `retain` carries a session link this projection already holds, so a re-hydration never
   * loses one it had. See DECISIONS-AUTO.md (2026-08-24) for the reversal condition.
   */
  private async hydrateProjectionPage(opts: ListRunsOptions): Promise<string | undefined> {
    const { runs, nextCursor } = await this.store.listRuns(opts);
    for (const run of runs) this.retain(factsOf(run), [], { lastSeq: run.lastSeq, projection: run });
    return nextCursor;
  }

  /**
   * The boot page, in as few round-trips as the bound store allows.
   *
   * It used to be `listRuns` and then one awaited `eventsSince` per run, strictly in series: fifty runs
   * meant fifty-one sequential stdio hops before the chrome could name anything. Worse, `listRuns`
   * already reads each run's projection events in the child to build the `Run`s it returns, so those
   * events crossed the pipe twice — once inside a projection this class recomputes anyway, once raw.
   * The combined read asks for facts+events and nothing else, in one hop for the whole page.
   */
  private async loadLogs(opts: ListRunsOptions = {}): Promise<RunLogPage> {
    if (this.store.listRunLogs) return this.store.listRunLogs(opts);
    const { runs, nextCursor } = await this.store.listRuns(opts);
    const entries = await Promise.all(
      runs.map(async (run) => ({ facts: factsOf(run), events: await this.readLog(run.id), lastSeq: run.lastSeq })),
    );
    return { entries, ...(nextCursor ? { nextCursor } : {}) };
  }

  /**
   * A whole log, in bounded pages.
   *
   * The single frame this replaces was the second half of the same defect as the boot read: the store
   * serialized an entire run log into one line and this process accumulated and parsed it in one go.
   *
   * It stops on an EMPTY page rather than a short one on purpose. The store enforces its own per-frame
   * ceiling regardless of what is asked for, so a short page is the ordinary shape of a capped read,
   * and treating it as the end would silently drop the rest of a log.
   */
  private async readLog(runId: string, since = 0): Promise<RunEvent[]> {
    const events: RunEvent[] = [];
    let cursor = since;
    for (;;) {
      const page = await this.store.eventsSince(runId, cursor, REPLAY_PAGE_SIZE);
      if (page.length === 0) return events;
      for (const event of page) events.push(event);
      const tail = page[page.length - 1]!.seq;
      // A store that ignored `since` would hand back the same page forever. Nothing legitimate
      // produces that; an infinite loop on the thread that paints is what it would cost if anything did.
      if (tail <= cursor) return events;
      cursor = tail;
    }
  }

  /**
   * Take a freshly-read log. The single seam every full replay goes through, so the derived facts a
   * condensed run keeps — its session id, its last seq, its kept projection — are computed in exactly
   * one place rather than at each of the four call sites that read a whole log.
   */
  private retain(facts: StoredRunFacts, events: RunEvent[], opts: RetainOptions = {}): void {
    // The store's tail wins, because a bounded read holds fewer envelopes than the run has and its
    // last seq would sit BELOW where the store actually is — which would make the next live
    // envelope look like a hole and replay a run that missed nothing. The max is not belt and
    // braces: the listing's tail seek and the event read are separate statements, so an append
    // landing between them puts the newer seq in the events, and taking the older one would let
    // `applyEvent` fold an envelope this log already holds.
    const lastSeq = Math.max(opts.lastSeq ?? 0, events.at(-1)?.seq ?? 0);
    // A read that is BEHIND what this projection has already folded is DROPPED rather than applied.
    // Every read here is a round-trip, so what comes back is where the store was when the child took
    // it: a boot page read at seq N−1 can land after the live tail has folded seq N, and overwriting
    // rewinds `lastSeq` below an envelope this log has already seen. Nothing repairs that afterwards
    // — a heal needs a LATER envelope to open a gap, and the envelope lost this way is typically the
    // run's last, so the app says `running` for a run that ended until it is restarted. Equality
    // still applies: a condensed run is re-read at the same tail to replace an inferred status with
    // the log's own.
    const held = this.logs.get(facts.id);
    if (held && held.lastSeq > lastSeq) return;
    // The link is a fact fixed at creation, so a read that cannot see it must not UNSET one this log
    // already holds. Two reads answer without it: `recondense`, which carries it by hand, and a boot
    // page taken from `listRuns` once the hydration allowance is spent — projections carry no
    // `run.created`. Carrying it here is what keeps a re-hydration from losing a session link the
    // first one found.
    const sessionId =
      opts.sessionId ?? events.find((e) => e.type === 'run.created')?.payload.sessionId ?? held?.sessionId;
    this.logs.set(facts.id, {
      facts,
      events,
      lastSeq,
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
    });
    this.projected.delete(facts.id);
    if (opts.projection) this.condense(facts.id, opts.projection);
    else if (events.some((e) => TERMINAL_EVENT_TYPES.has(e.type))) this.seal(facts.id);
    // After the log is in its final shape, never before: a replaced log is a wholesale change of
    // which tabs this run owns, and the projection that answers it is the condensed one when there is
    // one. Cheap here in a way it is not on the fold — a replay is rare, and the projection it costs
    // is memoised for the read that follows it.
    this.indexTabs(facts.id);
  }

  /**
   * Rebuild one run's entries in the tab index from its projection.
   *
   * Every entry this run owns is dropped first, because a replayed log can have LOST a tab — a detach
   * that landed while the read was on the wire — and an index that only ever added would leave the
   * run owning a tab its own projection no longer lists, which is law 4's refusal firing on a fact
   * that is not in the log.
   */
  private indexTabs(runId: string): void {
    // The reverse index names this run's entries, so the clear costs what THIS run owns rather than a
    // sweep of every tab on the machine. Copied before the walk because `disownTab` mutates the set
    // being iterated. It is at most one run's tabs; the forward map is every run's.
    for (const tabId of [...(this.tabsByRun.get(runId) ?? [])]) this.disownTab(runId, tabId);
    const log = this.logs.get(runId);
    if (!log) return;
    for (const tabId of log.kept?.tabIds ?? this.project(runId)?.tabIds ?? []) this.ownTab(runId, tabId);
  }

  /**
   * The index moved by ONE envelope, which is the whole reason `ownerOf` can stop scanning.
   *
   * The two rules are `projectRun`'s own: an attach adds the tab, a detach removes it only from the
   * run that holds it — a detach naming a tab this run does not own is a no-op there and has to be one
   * here, or one run's stale detach would silently unown another run's live tab.
   */
  private trackTabOwnership(runId: string, event: RunEvent): void {
    const tabId = event.payload.tabId;
    if (typeof tabId !== 'string' || tabId.length === 0) return;
    if (event.type === 'tab.attached') this.ownTab(runId, tabId);
    else if (event.type === 'tab.detached') this.disownTab(runId, tabId);
  }

  /**
   * Both directions of the index, written together — the only place an owner is recorded.
   *
   * An attach naming a tab another run currently owns takes it, which is what the forward map did on
   * its own, and the previous owner is told rather than left holding a reverse entry for a tab it no
   * longer owns. No public answer differs either way today — the clear below refuses to drop a forward
   * entry that is not this run's, so a stale entry is inert — and this keeps the invariant the reverse
   * index is only worth having if it holds: `tabsByRun.get(r)` is exactly the tabs `tabOwners` maps to
   * `r`. `attachTab` refuses this case at the seam above, so it reaches here only as a fact already in
   * a log.
   */
  private ownTab(runId: string, tabId: string): void {
    const prior = this.tabOwners.get(tabId);
    if (prior !== undefined && prior !== runId) this.disownTab(prior, tabId);
    this.tabOwners.set(tabId, runId);
    const owned = this.tabsByRun.get(runId);
    if (owned) owned.add(tabId);
    else this.tabsByRun.set(runId, new Set([tabId]));
  }

  /**
   * The inverse, with law 4's own refusal in it: the forward entry is dropped only if this run is the
   * one holding it. A run's stale detach naming another run's live tab clears its own bookkeeping and
   * nothing else — the same no-op `projectRun` folds. The empty set is dropped rather than kept, so a
   * machine's worth of finished runs does not leave a map entry each.
   */
  private disownTab(runId: string, tabId: string): void {
    if (this.tabOwners.get(tabId) === runId) this.tabOwners.delete(tabId);
    const owned = this.tabsByRun.get(runId);
    if (!owned) return;
    owned.delete(tabId);
    if (owned.size === 0) this.tabsByRun.delete(runId);
  }

  /**
   * Drop a finished run's envelopes, keeping the projection they produced.
   *
   * A terminal run's projection cannot move again, and every reader — `list`, `ownerOf`, `snapshot` —
   * asks for the projection, never the log. Holding the envelopes as well meant the app's memory grew
   * monotonically with every run it had ever seen and never gave any of it back, since runs are never
   * deleted and `hydrate` deliberately keeps what the listing did not name. Nothing observable changes;
   * what changes is that a run's cost here ends when the run does.
   *
   * An envelope that arrives for a sealed run afterwards is not folded — there is nothing to fold into
   * — it triggers a replay, which re-reads the log and re-seals it. Rare (the log is over) and bounded.
   */
  private seal(runId: string): void {
    const log = this.logs.get(runId);
    if (!log || log.kept) return;
    const run = this.snapshot(runId);
    if (!run || !isTerminal(run.status)) return;
    this.condense(runId, run);
  }

  /**
   * Hold a projection in place of envelopes this process does not have.
   *
   * Sealing a terminal run is one producer; the boot read is the other, when a run's log is too large
   * to cross the pipe in one frame and the store sends the projection it had already computed. The
   * two are the same state — reads answer from the projection, and the next envelope replays, because
   * there is nothing here to fold it into.
   */
  private condense(runId: string, projection: Run): void {
    const log = this.logs.get(runId);
    if (!log) return;
    log.events = [];
    log.kept = projection;
    this.projected.delete(runId);
  }

  /**
   * Fold one envelope in. Idempotent by `seq`, because the broker notifies us about our own appends and a
   * reconnecting tail replays — applying an envelope twice would double-count a `tab.attached`.
   */
  applyEvent(runId: string, event: RunEvent): void {
    const log = this.logs.get(runId);
    // A run this projection has never seen — created by the REST surface, or by another writer in this
    // process. Folding one mid-stream envelope in would leave a run whose history starts at seq 9, so
    // the whole log is replayed instead. Without this it would stay invisible until the next hydrate,
    // and nothing calls hydrate after boot.
    if (!log) { void this.adopt(runId); return; }
    if (event.seq <= log.lastSeq) return;
    // A gap means an envelope was missed — one that landed while this run was being adopted, or a
    // dropped notify. Appending the newer one anyway would leave a log that silently disagrees with the
    // store, so the run is replayed from scratch instead. Same contract as #46's SSE tail. A sealed run
    // takes the same path for a different reason: its envelopes are gone, so folding is not available.
    if (event.seq > log.lastSeq + 1 || log.kept) { void this.adopt(runId, { replace: true }); return; }
    log.events.push(event);
    log.lastSeq = event.seq;
    this.trackTabOwnership(runId, event);
    this.projected.delete(runId);
    if (TERMINAL_EVENT_TYPES.has(event.type)) this.seal(runId);
    this.emit();
  }

  /**
   * Fold in an envelope this class just wrote. A sealed run has nothing to fold into, so it is replayed
   * instead — and awaited, so the projection is current by the time the caller's promise settles. That
   * matters for the one legal write to a finished run: demoting it, which is what a boot reconcile does
   * to a run that ended while it was being watched.
   */
  private async fold(runId: string, event: RunEvent): Promise<void> {
    const log = this.logs.get(runId);
    // The store notifies before the append's RPC resolves, so by the time we get here this envelope is
    // usually already in. Checked BEFORE the sealed branch: an append that seals the run would
    // otherwise replay it immediately afterwards to fold an envelope it has already folded.
    if (log && event.seq <= log.lastSeq) return;
    // Everything a plain fold cannot absorb is a replay, and it is AWAITED here. A caller that wrote
    // through this class is entitled to a current projection by the time its promise settles —
    // `attachTab`'s law-4 refusal is decided on that projection, and `setVisibility`'s idempotence
    // is too. `applyEvent` starts the same replay for its own callers but has no promise to hand
    // back, so routing a gap or a sealed run through it would resolve the write before the write
    // was visible anywhere.
    if (!log || log.kept || event.seq > log.lastSeq + 1) { await this.adopt(runId, { replace: true }); return; }
    this.applyEvent(runId, event);
  }

  /**
   * Replay one run into the projection. The in-flight map and the post-await `has` check together keep a
   * burst of events for the same unknown run to a single replay, and keep it from racing `createRun`,
   * which registers the same id by a shorter path (the store notifies before its RPC resolves).
   */
  private adopt(runId: string, opts: { replace?: boolean } = {}): Promise<void> {
    const inFlight = this.adopting.get(runId);
    if (inFlight) {
      // NEITHER kind is answerable by a replay that is already reading, which is what returning the
      // in-flight promise used to claim. A replace one may have read the store before the envelope
      // that opened this gap was committed; and a NON-replace one — `applyEvent`'s unknown-run arm —
      // is the same race with no later envelope to heal it. That arm is reached once per envelope
      // until the adoption lands, so envelope A starts the replay and envelope B, arriving while its
      // `readLog` is still on the wire, used to be dropped on the floor: `again` was set by
      // `opts.replace` alone, the read that resolves afterwards holds the store as of BEFORE B, and
      // `retain` pins `lastSeq` below it. Nothing repairs that — a heal needs a LATER envelope to
      // open a gap — so when B was the run's last (`run.completed`), the app said `running` forever
      // while REST, projecting the same log fresh, said `done`. Two answers, one log; law 1.
      // REST-surface appends reach `applyEvent` through `store.onRunEvent`, so this is a live path.
      //
      // So EVERY caller that arrives mid-replay asks for one more pass. They all coalesce into the
      // one owed pass, so a burst still costs one extra replay rather than one per envelope, and the
      // promise handed back does not settle until that pass is done.
      inFlight.again = true;
      return inFlight.promise;
    }
    if (this.logs.has(runId) && !opts.replace) return Promise.resolve();
    const state: AdoptState = { promise: Promise.resolve(), again: false };
    const drain = async (): Promise<void> => {
      await this.replay(runId, opts);
      while (state.again) {
        state.again = false;
        await this.replay(runId, { replace: true });
      }
    };
    state.promise = drain().finally(() => {
      if (this.adopting.get(runId) === state) this.adopting.delete(runId);
    });
    this.adopting.set(runId, state);
    return state.promise;
  }

  private async replay(runId: string, opts: { replace?: boolean }): Promise<void> {
    try {
      if (opts.replace && this.overBound(runId)) { await this.recondense(runId); return; }
      const facts = await this.readFacts(runId);
      if (!facts || (this.logs.has(runId) && !opts.replace)) return;
      const events = await this.readLog(runId);
      if (this.logs.has(runId) && !opts.replace) return;
      this.retain(facts, events);
      this.emit();
    } catch {
      // The store is unreachable; the run is not lost, only unseen. A later event retries.
    }
  }

  /**
   * Is this run condensed AND still too long to materialize? Answered from `lastSeq`, which the store
   * has already told us, so deciding costs no read at all — the read is what the decision is about.
   */
  private overBound(runId: string): boolean {
    const log = this.logs.get(runId);
    return log?.kept !== undefined && log.lastSeq > REMATERIALIZE_MAX_EVENTS;
  }

  /**
   * Replace a condensed run's kept projection with the store's current one, and stay condensed.
   *
   * One round-trip, and `getRun` is the read that WANTS the projection — the objection that made
   * `readFacts` stop using it (projecting to throw the projection away) does not apply here, because
   * the projection is the answer. Every reader is served from it exactly as it was before the
   * envelope arrived, `lastSeq` comes back as the store's real tail so the next envelope is still
   * recognised as the next one, and the session link is carried over because a projection cannot
   * rebuild it and no envelope is coming to replay it from.
   */
  private async recondense(runId: string): Promise<void> {
    const held = this.logs.get(runId);
    const run = await this.store.getRun(runId);
    if (!run) return;
    this.retain(factsOf(run), [], {
      lastSeq: run.lastSeq,
      projection: run,
      ...(held?.sessionId ? { sessionId: held.sessionId } : {}),
    });
    this.emit();
  }

  /**
   * The four stored facts a replay needs before it reads the log.
   *
   * This was `getRun`, which made the store PROJECT the run — reading its projection rows, folding
   * its cost, seeking its tail — so that every field but four could be discarded here, immediately
   * before reading the same log again to build the projection this class actually uses. One gap,
   * two reads of one log.
   */
  private async readFacts(runId: string): Promise<StoredRunFacts | undefined> {
    if (this.store.runFacts) return this.store.runFacts(runId);
    const run = await this.store.getRun(runId);
    return run ? factsOf(run) : undefined;
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const run = await this.store.createRun(input);
    const events = await this.readLog(run.id);
    this.retain(factsOf(run), events, { lastSeq: run.lastSeq });
    this.emit();
    return run;
  }

  /**
   * How many raw envelopes this projection is holding for a run. Zero once the run is terminal, and
   * zero for a run whose log was condensed at boot — the retention bound is a property callers and
   * tests can actually check, not a comment.
   */
  retainedEventCount(runId: string): number {
    return this.logs.get(runId)?.events.length ?? 0;
  }

  /**
   * The daemon studio session that spawned this run (§7.3's linkage), replayed from `run.created`.
   * A session is how a client connects; a run is the task — so the link is a recorded fact, not a
   * second map for the host to keep in step with the log.
   */
  sessionIdOf(runId: string): string | undefined {
    return this.logs.get(runId)?.sessionId;
  }

  runForSession(sessionId: string): string | undefined {
    for (const runId of this.logs.keys()) if (this.sessionIdOf(runId) === sessionId) return runId;
    return undefined;
  }

  /**
   * The LIVE run a still-pending decision belongs to, replayed rather than remembered. An answer
   * arrives carrying only the card's id, and a map from card to run would be one more thing to keep in
   * step with the log — the log already knows, because a resolved decision is no longer pending.
   *
   * Terminal runs are skipped, which is the same narrowing `listLive` takes and for the same reason:
   * this walked and PROJECTED every run the machine had ever held, and it grows with the lifetime run
   * count exactly the way the state push did. A sealed run is skipped without projecting at all — its
   * kept projection states the terminal status, and no read can move that.
   *
   * Narrowing it costs nothing observable. The one caller, `run-decisions`' `settle`, re-reads the
   * status of whatever it gets back and refuses to write once the run is terminal — appending a
   * `decision.resolved` after `run.completed` would be an out-of-order fact in an append-only log — so
   * a terminal run was never an answer that could be acted on, only one more projection on the way
   * past. Reverse this the moment some caller needs the run behind a card the log has already closed.
   */
  runForDecision(decisionId: string): string | undefined {
    for (const [runId, log] of this.logs) {
      if (log.kept && isTerminal(log.kept.status)) continue;
      const run = this.snapshot(runId)!;
      if (isTerminal(run.status)) continue;
      if (run.pendingDecisions.some((d) => d.decisionId === decisionId)) return runId;
    }
    return undefined;
  }

  /**
   * Run one ownership change for a tab after every change already queued for THAT tab, and hand back
   * its result.
   *
   * Every operation here is a check-then-act across an await: the check reads the PROJECTION and the
   * append is a round-trip, so two of them issued in the same turn both decide against a projection
   * neither has moved yet, and both commit. That is law 4 broken in the DURABLE record, where no
   * replay repairs it and nothing detects it — every surface that reads the log afterwards, here or
   * over REST or in a replay, sees the contradiction, and an agent drives another agent's page.
   *
   * Attach and detach share ONE queue rather than having one each, because the pairs that race are
   * mixed: an attach whose append is still on the wire against the human closing the same tab, and a
   * human close against the release `endRun` writes for the same tab. Two queues would serialise each
   * kind against itself and leave both of those exactly as unserialised as no queue at all.
   *
   * Per TAB rather than globally, so a slow append for one tab never holds up an ownership change to
   * another — the tab is the thing law 4 is about, and the broker's appends can take seconds.
   * `setVisibility` serialises per run against the same shape of race.
   *
   * The rejection handler is the same call as the fulfilment one: a queued operation runs whether the
   * one before it committed or refused, because a refusal changed nothing for it to be behind.
   */
  private queueForTab<T>(tabId: string, op: () => Promise<T>): Promise<T> {
    const queued = (this.tabOps.get(tabId) ?? Promise.resolve()).then(op, op);
    const tail = queued.then(
      () => { if (this.tabOps.get(tabId) === tail) this.tabOps.delete(tabId); },
      () => { if (this.tabOps.get(tabId) === tail) this.tabOps.delete(tabId); },
    );
    this.tabOps.set(tabId, tail);
    return queued;
  }

  /**
   * Law 4's enforcement seam. Attaching a tab another run owns is refused outright; re-attaching to the
   * owner is a no-op rather than a duplicate fact.
   */
  attachTab(runId: string, tabId: string, url?: string): Promise<void> {
    return this.queueForTab(tabId, () => this.applyAttach(runId, tabId, url));
  }

  private async applyAttach(runId: string, tabId: string, url?: string): Promise<void> {
    const owner = this.ownerOf(tabId);
    if (owner === runId) return;
    if (owner !== undefined) throw new TabOwnedError(tabId, owner);
    // The url is narrowed to its ORIGIN here, at the constructor, rather than at any call site: the run
    // log is append-only with no prune path by design, and is served over `GET /v1/runs/{id}/events` and
    // the SSE tail, so a query string that gets in is a secret stored forever and handed to every client
    // past the REST gate. The agent supplies this url (`studio_open`'s startUrl), and an agent handed a
    // magic link is the ordinary case, not the adversarial one. Same rule the audit path already applies.
    const event = await this.store.appendEvent(runId, {
      actor: { kind: 'agent', driver: 'studio' },
      type: 'tab.attached',
      payload: { tabId, ...(url ? { url: originOnly(url) } : {}) },
    });
    await this.fold(runId, event);
  }

  /**
   * A tab nobody owns is the human's, and closing it is not a run fact.
   *
   * Queued on the same per-tab lane as `attachTab`, and that is what makes the ownership read below
   * true rather than merely likely. Unqueued it read `ownerOf` the instant it was called, which two
   * ordinary sequences broke. A human closes a tab while its attach is still on the wire — the broker
   * can take seconds — so this read finds no owner, returns, and the attach then commits: the run
   * durably owns a destroyed tab forever, `agentVisibleTabs` lists it and `promote()` focuses a dead
   * id. And a human close racing `endRun`'s `run_ended` release: both read the owner before either
   * folds, and the append-only log takes two `tab.detached` facts for one detachment.
   */
  detachTab(tabId: string, reason: TabDetachReason): Promise<void> {
    return this.queueForTab(tabId, () => this.applyDetach(tabId, reason));
  }

  private async applyDetach(tabId: string, reason: TabDetachReason): Promise<void> {
    const runId = this.ownerOf(tabId);
    if (runId === undefined) return;
    const event = await this.store.appendEvent(runId, {
      actor: { kind: 'agent', driver: 'studio' },
      type: 'tab.detached',
      payload: { tabId, reason },
    });
    await this.fold(runId, event);
  }

  /**
   * Terminal transition: release the run's tabs first, so the log never ends owning a dead tab.
   *
   * The membership read is deliberately taken here and not inside the lane: it names the tabs to TRY,
   * and `applyDetach` decides per tab, on the queue, whether there is still anything to release. A tab
   * a human closed in the meantime is folded to a no-op there rather than written twice here.
   */
  async endRun(runId: string, terminal: RunTerminal, detail?: string): Promise<void> {
    for (const tabId of this.tabsOf(runId)) await this.detachTab(tabId, 'run_ended');
    const payload: Record<string, unknown> =
      terminal === 'failed' ? { error: detail ?? 'the run ended unexpectedly' }
        : terminal === 'cancelled' ? { by: 'system' }
          : { ...(detail ? { outcome: detail } : {}) };
    const event = await this.store.appendEvent(runId, { actor: { kind: 'system' }, type: `run.${terminal}`, payload });
    await this.fold(runId, event);
  }

  /**
   * §8's promote/demote, as a fact in the log rather than as window state.
   *
   * The store enforces envelope mechanics only, so legality lives here: promoting a run that has
   * already ended is refused (nobody can watch a run that is over), while demoting one is allowed —
   * that is exactly the path a boot reconcile takes for a run that ended while it was being watched.
   *
   * Idempotent against the PROJECTION, not against a local flag: a promote written by another writer
   * is already in this projection, so re-asserting it here writes nothing. Returns whether an event
   * was appended, which is what a caller needs to know before it moves a window.
   */
  setVisibility(runId: string, next: Run['visibility'], by: PresentationBy, surface?: PromoteSurface): Promise<boolean> {
    // Serialised per run, because the check below is against the PROJECTION: two clicks on the same
    // menu item both read "hidden" before either append lands, and the log gets two promotes for one
    // transition. A human double-clicking is the ordinary way to produce that. Per run, not global, so
    // one run's slow append never holds another's up.
    const queued = (this.transitions.get(runId) ?? Promise.resolve()).then(
      () => this.applyVisibility(runId, next, by, surface),
      () => this.applyVisibility(runId, next, by, surface),
    );
    const tail = queued.then(
      () => { if (this.transitions.get(runId) === tail) this.transitions.delete(runId); },
      () => { if (this.transitions.get(runId) === tail) this.transitions.delete(runId); },
    );
    this.transitions.set(runId, tail);
    return queued;
  }

  private async applyVisibility(runId: string, next: Run['visibility'], by: PresentationBy, surface?: PromoteSurface): Promise<boolean> {
    const run = this.snapshot(runId);
    if (!run) throw new Error(`no such run: ${runId}`);
    if (run.visibility === next) return false;
    if (next === 'visible' && isTerminal(run.status)) throw new Error(`run ${runId} has already ended`);
    const event = await this.store.appendEvent(runId, {
      actor: { kind: by },
      type: next === 'visible' ? 'presentation.promoted' : 'presentation.demoted',
      payload: next === 'visible' ? { by, ...(surface ? { surface } : {}) } : { by },
    });
    await this.fold(runId, event);
    return true;
  }

  /** A card the human has to answer, recorded on the run it blocks (law 10, and `needs_you`'s source). */
  async requestDecision(runId: string, input: { decisionId: string; kind: string; prompt: string }): Promise<void> {
    const event = await this.store.appendEvent(runId, {
      actor: { kind: 'agent', driver: 'studio' },
      type: 'decision.requested',
      payload: { decisionId: input.decisionId, kind: input.kind, prompt: input.prompt },
    });
    await this.fold(runId, event);
  }

  async resolveDecision(runId: string, decisionId: string, outcome: 'approved' | 'denied' | 'auto_denied', by: 'human' | 'system'): Promise<void> {
    const event = await this.store.appendEvent(runId, {
      actor: { kind: by },
      type: 'decision.resolved',
      payload: { decisionId, outcome, by },
    });
    await this.fold(runId, event);
  }

  /**
   * Law 4's question, answered from the index rather than by searching for it. See `tabOwners` for
   * why: this is asked once per tab per state push, and the scan it replaces was the only reason a
   * broadcast's cost grew with how many runs the machine had ever seen.
   */
  ownerOf(tabId: string): string | undefined {
    return this.tabOwners.get(tabId);
  }

  isUserTab(tabId: string): boolean {
    return this.ownerOf(tabId) === undefined;
  }

  /**
   * A COPY, always. `snapshot` hands back the memoised projection itself, so its `tabIds` is one
   * array shared by every caller for as long as the memo lives — and callers treat what they are
   * given as theirs: `endRun` iterates it while detaching, and any consumer is free to sort, splice
   * or reverse it. One of those would rewrite the cached projection under everyone else, and the run
   * would appear to have lost a tab that was never detached. The copy is what makes the memo an
   * implementation detail rather than a contract every caller has to know about.
   */
  tabsOf(runId: string): string[] {
    return this.snapshot(runId)?.tabIds.slice() ?? [];
  }

  /**
   * The agent-visible tab enumeration. Built from what the run owns and then narrowed to what still
   * exists — never from the tab universe filtered down, so a tab the human opened has no path into it.
   *
   * Both arms return a fresh array: `filter` builds one, and the unfiltered arm is already `tabsOf`'s
   * copy rather than the memo's own.
   */
  agentVisibleTabs(runId: string, universe?: readonly string[]): string[] {
    const owned = this.tabsOf(runId);
    return universe ? owned.filter((t) => universe.includes(t)) : owned;
  }

  /** The human's own group: everything in the universe that no run has ever attached. */
  userTabs(universe: readonly string[]): string[] {
    return universe.filter((t) => this.isUserTab(t));
  }

  /**
   * Every run this process holds, finished ones included — the history read, answered on demand.
   *
   * NOT what a surface renders. Nothing here is forgotten: sealing a terminal run drops its envelopes
   * and keeps its projection, and `hydrate` deliberately keeps runs the listing did not name, so this
   * grows with the machine's lifetime run count and never gives any of it back. See `listLive`.
   */
  list(): RunSummary[] {
    return [...this.logs.keys()].map((id) => summaryOf(this.snapshot(id)!));
  }

  /**
   * What the surfaces render: `isListable` applied before the summary is built, not after.
   *
   * The state push fires once per 16 ms coalescing window and used to carry `list()`, so every
   * broadcast paid for every run the machine had ever seen — measured at 2,000 terminal + 2 live runs,
   * 253 KB per fan-out, and at 10,000 runs with realistic task strings, 4.6 MB and 7 ms of a 16 ms
   * frame, on the thread that paints, with structured clone dominating. The tray and the presentation
   * controller each read on the same fan-out, so the cost was paid three times over.
   *
   * The skip is taken from the LOG rather than from a projection wherever it can be: a sealed run
   * holds the projection it ended with, and neither of the two things a read can still change about it
   * — `withoutExpiredDecisions` only ever drops a card and downgrades `needs_you` to `running` — can
   * move a terminal status or a visibility. So a finished, unwatched run costs a map lookup and a
   * comparison here instead of a `snapshot` call, and the walk is O(live runs) in an app where every
   * run this process finished is sealed. A terminal run that is NOT sealed (adopted mid-flight, say)
   * falls through to the correct arm rather than to a wrong answer.
   */
  listLive(): RunSummary[] {
    const out: RunSummary[] = [];
    for (const [id, log] of this.logs) {
      if (log.kept && !isListable(log.kept)) continue;
      const run = this.snapshot(id)!;
      if (!isListable(run)) continue;
      out.push(summaryOf(run));
    }
    return out;
  }

  /**
   * The projection, memoised — and expired on the clock as well as on the log.
   *
   * The memo used to be keyed on the log alone, which made it wrong for the one field `projectRun`
   * derives from the wall clock. A run holding a pending decision projects as `needs_you` until the
   * card auto-denies two minutes later, and that transition arrives WITHOUT an event: nothing drops
   * the memo, so the tray and the dock badge went on saying "needs you" indefinitely while the REST
   * surface — projecting fresh, with its own clock — said the run was running. Two surfaces
   * disagreeing about one log is the class of defect law 1 exists to remove, so the memo carries the
   * deadline that can invalidate it.
   */
  snapshot(runId: string): Run | undefined {
    const log = this.logs.get(runId);
    if (!log) return undefined;
    if (log.kept) {
      const kept = withoutExpiredDecisions(log.kept, this.now());
      this.trackHorizon(runId, kept);
      // The narrowing INFERRED a status — see `withoutExpiredDecisions`. A condensed run has the log
      // that could state it, just not here, so re-read it. Deduped by `adopt`, and a no-op after the
      // first one lands for a run the re-read materializes, because it is no longer condensed.
      if (kept !== log.kept) this.rereadCondensed(runId);
      return kept;
    }
    return this.project(runId);
  }

  /** The memoised projection of a log this process still holds. `snapshot` minus the condensed arm. */
  private project(runId: string): Run | undefined {
    const log = this.logs.get(runId);
    if (!log) return undefined;
    const now = this.now();
    const memo = this.projected.get(runId);
    if (memo && (memo.staleAt === undefined || now.getTime() < memo.staleAt)) return memo.run;
    const run = projectRun(log.facts, log.events, now);
    this.projected.set(runId, { run, staleAt: autoDenyHorizonOf(run) });
    this.trackHorizon(runId, run);
    return run;
  }

  /**
   * Ask the store for a condensed run's real status, at most once per tail. See `statusRereads`.
   */
  private rereadCondensed(runId: string): void {
    const log = this.logs.get(runId);
    if (!log?.kept || this.statusRereads.get(runId) === log.lastSeq) return;
    this.statusRereads.set(runId, log.lastSeq);
    void this.adopt(runId, { replace: true });
  }

  /**
   * Announce the clock-driven transition at the moment it happens, instead of only when someone reads.
   *
   * The memo's `staleAt` made `snapshot` CORRECT when asked, and that fixed half the defect: `emit`
   * fires on events, the `needs_you → running` transition at `autoDenyAt` arrives without one, and
   * nothing asks a quiet run. So the tray label, the dock badge and the presentation controller kept
   * saying "needs you" over a card the broker had already refused, while REST — projecting fresh on
   * every request — said the run was running. One log, two answers, which is the class law 1 exists
   * to remove; a memo that expires on read cannot close it, only a fan-out at the deadline can.
   *
   * A terminal run is never scheduled: its status cannot move again, and `withoutExpiredDecisions`
   * already strips a card it ended holding.
   */
  private trackHorizon(runId: string, run: Run): void {
    const at = isTerminal(run.status) ? undefined : autoDenyHorizonOf(run);
    const current = this.horizons.get(runId);
    if (current?.at === at) return;
    current?.stop();
    this.horizons.delete(runId);
    if (at === undefined) return;
    const stop = this.setTimer(() => {
      this.horizons.delete(runId);
      this.projected.delete(runId);
      // A condensed run has no envelopes left to re-project, so `withoutExpiredDecisions` is guessing
      // at a status the store can state: replay it rather than let the guess stand.
      this.rereadCondensed(runId);
      this.emit();
    }, Math.max(0, at - this.now().getTime()));
    this.horizons.set(runId, { at, stop });
  }
}

/**
 * A projection as the surfaces name it.
 *
 * `tabIds` is copied for the same reason `tabsOf` copies: this summary is handed to the tray, to the
 * renderer's state push and to the presentation controller, and it must not be a handle on the memo.
 * This one crosses an IPC boundary as well, and the structured clone would only hide the aliasing from
 * the renderer, never from main.
 */
function summaryOf(run: Run): RunSummary {
  return { id: run.id, task: run.task, status: run.status, tabIds: run.tabIds.slice(), visibility: run.visibility };
}

/** The first moment the clock alone can change this projection: the earliest pending auto-deny. */
function autoDenyHorizonOf(run: Run): number | undefined {
  let earliest: number | undefined;
  for (const decision of run.pendingDecisions) {
    const at = Date.parse(decision.autoDenyAt);
    if (Number.isFinite(at) && (earliest === undefined || at < earliest)) earliest = at;
  }
  return earliest;
}
