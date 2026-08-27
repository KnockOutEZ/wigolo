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
  /**
   * What that projection had to leave out to fit the page's character budget, per field.
   *
   * The store bounds a condensed run's pending-card list by COUNT as well as by characters, and it
   * reports the shortfall precisely so this side does not treat the shortened list as the run's state
   * — see `MAX_BOOT_PENDING_CARDS` in `studio-db-broker.ts`. The report used to arrive and stop here:
   * nothing carried it, so a run that raised more than the cap booted showing the cap's worth of
   * cards, `runForDecision` could not find the rest, and no read was owed until the run happened to
   * emit again. A run that then went quiet held those cards invisibly for the app's whole life.
   *
   * Present only when something was dropped, so an ordinary condensed entry is unchanged. `retain`
   * answers a non-zero count with the same store re-read the horizon timer issues, which is what
   * turns the report into a repair rather than a fact nobody acts on.
   */
  projectionOmitted?: { pendingDecisions: number };
  /** The session link `run.created` carries, when no envelope came with it to replay it from. */
  sessionId?: string;
}

/** A page of the boot listing, with the cursor that continues it. */
export interface RunLogPage {
  entries: RunLogEntry[];
  nextCursor?: string;
  /**
   * What the STORE spent reading this page — every run it materialized, including the ones it then
   * condensed and answered with a projection.
   *
   * `entries` is what came back, and what came back is not what was read: a condensed entry carries no
   * envelopes and the store paid for its log anyway. Charging the hydration's allowance by
   * `events.length` therefore charged zero for exactly the runs that cost the most, which left the
   * allowance untouched and the log branch taken for every page — so the store's per-call budget was
   * multiplied by `MAX_HYDRATION_PAGES`.
   *
   * Optional because this is a port. A store that omits it is one with no per-call budget to reset —
   * the fallback in `loadLogs` reads each log itself and condenses nothing — so there, what came back
   * IS what was read and `events.length` is the honest charge.
   */
  eventsSpent?: number;
  charsSpent?: number;
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
  /**
   * The store became reachable — at boot, and again after every respawn.
   *
   * `ADOPT_RETRY_BASE_MS` records that backoff asks the only question that could be asked, because
   * the client was request/response plus a notify tail and the tail said nothing about whether a READ
   * would succeed. This is that missing signal, and it is the store's own `ready`: a chain that walked
   * to `MAX_ADOPT_RETRIES` while the store was down has no later envelope to heal it when the run's
   * only envelope is its `run.created`, so the run stays invisible to every surface until the app is
   * restarted. Optional for the same reason as `listRunLogs` — a binding without a respawn has nothing
   * to announce, and the backoff chain alone is what it had before.
   */
  onReady?(handler: () => void): void;
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
    onReady: (handler) => broker.onReady(handler),
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

/**
 * `attachTab`'s other refusal: the run cannot take an ownership fact at all.
 *
 * A THROW rather than the silent return `requestDecision`/`resolveDecision` use, because attach is the
 * one lifecycle write whose caller acts on the answer — `studio-host`'s `open()` hands the agent a
 * `session_id` on the strength of it, and a session id naming a run that never took the tab is a
 * success response for work that did not happen (law 9). `reason` separates the two ways a run can be
 * unable to own a page, because they unwind differently upstream: `ended` means somebody already wrote
 * the terminal event, `unknown` means this process is not holding the run and so cannot say.
 */
export class RunNotOpenError extends Error {
  constructor(readonly runId: string, readonly reason: 'ended' | 'unknown') {
    super(reason === 'ended' ? `run ${runId} has already ended` : `no such run: ${runId}`);
    this.name = 'RunNotOpenError';
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
 * The types a condensed run cannot fold in place, because folding them needs state a PROJECTION does
 * not carry — see `foldCondensed`.
 *
 * `statusFrom` decides a run's status from three facts: a terminal verdict, a `pausedReason`, and
 * whether any card is pending. A `Run` carries the ANSWER and two of the three inputs; the pause
 * reason is nowhere on it. So `status: 'needs_you'` on a kept projection is either "a card is open"
 * or "the run paused at a cap", and `status: 'paused'` says a reason exists without saying which —
 * which means a `decision.resolved` or a `run.resumed` folded onto it would have to GUESS which of
 * two states the run is returning to. A wrong status on a run is worse than a round-trip, and these
 * types happen at human scale — a pause, a card, an ending — not at browser-action scale. So they
 * keep the re-read, and every type that IS a pure function of the projection folds for free.
 */
const STATUS_FOLD_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...TERMINAL_EVENT_TYPES,
  'run.paused',
  'run.resumed',
  'decision.requested',
  'decision.resolved',
]);

/** The slice of an envelope `projectRun` reads. Structural, because the barrel does not export it. */
type ProjectableEvent = Pick<RunEvent, 'seq' | 'ts' | 'type' | 'payload'>;

/**
 * The two projected fields `ProjectRunOptions` cannot seed, expressed as the envelopes that produce
 * them — which is what lets a fold-in-place BE `projectRun` rather than a second copy of its rules.
 *
 * `cost`, `visibility`, `pendingDecisions` and `status` are seedable; `driver` and `tabIds` are not,
 * because the store's own bounded read rebuilds them from a type-filtered read of the log instead.
 * Replaying them as a `run.created` and one `tab.attached` per held tab reproduces both exactly —
 * the attach arm dedupes and appends in order, so the array comes back in the order the run took its
 * tabs, and the detach arm can then remove from it by the same rule it always did.
 *
 * Bounded by how many tabs the run HOLDS, not by how long it has been running, which is the whole
 * difference between this and the read it replaces.
 *
 * The seq and ts are deliberately the run's own birth values: `projectRun` takes `lastSeq` and
 * `updatedAt` from the LAST event it is given, which is the real envelope, never one of these.
 */
function keptSeed(run: Run): ProjectableEvent[] {
  const ts = run.createdAt;
  const seed: ProjectableEvent[] = [{ seq: 0, ts, type: 'run.created', payload: { driver: run.driver } }];
  for (const tabId of run.tabIds) seed.push({ seq: 0, ts, type: 'tab.attached', payload: { tabId } });
  return seed;
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
 *
 * A SPIN GUARD, and only that. It was standing in for a bound on what boot reads and it is eight times
 * too large to be one — see `MAX_BOOT_HYDRATION_RUNS`, which is the bound derived from what retention
 * can hold and the one that stops an ordinary boot.
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
 * evicted afterwards either: `retain` held every entry's envelopes for the process's life, and the
 * listing carries no status filter, so a run that ended months ago was read, parsed and held exactly
 * like a live one. (`MAX_RETAINED_SEALED_RUNS` and `MAX_RETAINED_LIVE_RUNS` are the two cuts that now
 * do, and `MAX_BOOT_HYDRATION_RUNS` is what stops boot reading past what they will keep — but the
 * allowance below is still what bounds one boot's WORK, which no retention cut can.)
 *
 * So the allowance is carried across the hydration instead. Once it is spent, the remaining pages
 * are taken from `listRuns` — projections only, no envelopes on the wire at all — which is the same
 * answer the store already gives for a single log too large for one frame, and the same one REST
 * gives for that run. Every reader stays correct, and the run replays in bounded pages when it next
 * speaks.
 *
 * Pinned to the store's own per-frame event allowance, so the two decisions cannot drift into
 * disagreeing about the same boot. The shipped bound on what boot RETAINS is therefore
 * `MAX_BOOT_HYDRATION_EVENTS` plus at most one page — the page that spends the last of it is
 * finished rather than torn in half, because an entry refused mid-page has no projection to be kept
 * in place of its envelopes.
 *
 * This allowance alone does NOT bound what boot READS: see `MAX_BOOT_HYDRATION_CHARS`, which is the
 * other half of the same bound and the reason the total is what one frame used to be.
 *
 * The listing is newest-first, so the allowance is spent on the runs a surface is most likely to
 * name, and the ones answered by projection are the oldest — which are also the ones most likely to
 * be terminal, and a terminal run's envelopes are dropped by `seal` the moment they are folded.
 */
export const MAX_BOOT_HYDRATION_EVENTS = 20_000;

/**
 * How many characters the WHOLE hydration may make the store READ — across every page, not per page.
 *
 * The event allowance bounds what this process retains, and a retention bound is not a read bound.
 * The store spends BOTH an event and a character allowance per call, and it charges them at the read
 * rather than at the acceptance — a run it materializes and then condenses is charged for in the
 * child and arrives here with `events: []`. So a corpus of condensed runs — few envelopes, large
 * payloads, an unlucky shape rather than an adversarial one — spent nothing of the event allowance
 * on the way past. `eventsLeft` never fell, every page kept taking the log branch, and each one
 * handed the store a freshly reset character allowance: the store's per-call budget multiplied by
 * `MAX_HYDRATION_PAGES`, synchronously, in the child that serialises every other read during boot.
 *
 * So the character allowance is carried across the hydration too, charged by what the store reports
 * it SPENT. Pinned to the store's own per-frame character allowance for the same reason as the event
 * one: two numbers deciding one boot must not drift. Once either is spent the remaining pages come
 * from `listRuns` — projections only, no envelopes read, materialized or parsed — which is what
 * makes the total across the boot one frame's work plus at most the page that spent the last of it.
 *
 * NOT injectable separately from `HydrateOptions.charBudget`, and forced there for the same reason
 * `eventBudget` is: the behaviour either side of the line is identical whatever the line is, and a
 * test that has to ALLOCATE four million characters measures its own fixture.
 */
export const MAX_BOOT_HYDRATION_CHARS = 4_000_000;

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

/**
 * How long after a refused adoption the run is re-adopted, in ms. Doubles per attempt, up to
 * `ADOPT_RETRY_MAX_MS`, for at most `MAX_ADOPT_RETRIES` attempts.
 *
 * `replay` used to swallow the store's failure on the grounds that a later event retries. That is
 * true for a run this projection is already folding — the next envelope arrives with a seq beyond
 * `lastSeq`, which opens a gap, which replays. It is FALSE for the one class of run the unknown-run
 * arm exists to catch. A run created over REST has exactly one envelope the REST surface will ever
 * append, its `run.created`, so a broker read that fails at that moment has no successor to heal it:
 * the run is in the store, in REST's own answer, and in no surface this app owns — not `list`, not
 * `listLive`, not the tray, not the state push — until the app is restarted. One log, two answers;
 * law 1, and the SD1 exit clause "run id visible everywhere" failing for exactly the run class the
 * gate is about.
 *
 * So the failure is remembered and re-attempted instead, bounded on both axes. The COUNT is bounded
 * so a permanently dead broker stops rather than spins, and an exhausted chain is not re-armed by
 * the next envelope that fails the same way — a half-dead broker, one still fanning notifies out
 * while its reads refuse, would otherwise buy a fresh chain per envelope, which is more spin than
 * the swallow this replaces. The STEP is bounded so a store that comes back after a minute is still
 * picked up inside one, rather than after a backoff that has doubled its way into the hours.
 *
 * A health signal from the broker would be the sharper trigger, and there is no such signal to
 * subscribe to: the client is request/response plus a notify tail, and the tail says nothing about
 * whether a READ would succeed. Backoff asks the only question that can be asked. Reverse this the
 * day the broker publishes a reachability event.
 *
 * The timer is the INJECTED one, for both of the reasons the constructor gives: unreffed, so a
 * pending retry can never be why the app stays alive, and drivable, so a test can force the race
 * rather than sleep through the backoff.
 */
export const ADOPT_RETRY_BASE_MS = 250;
/** The longest one backoff step may become — see `ADOPT_RETRY_BASE_MS`. */
export const ADOPT_RETRY_MAX_MS = 30_000;
/** How many times a refused adoption is re-attempted before the run waits for a later envelope. */
export const MAX_ADOPT_RETRIES = 8;

/**
 * How many TERMINAL, unwatched, sealed runs this process keeps the projection of.
 *
 * Sealing bounded what a finished run COSTS — its envelopes go, its projection stays — and left the
 * count itself unbounded. Runs are never deleted, `hydrate` deliberately keeps runs a later listing
 * did not name, and nothing ever removed a key: `logs` and `statusRereads` gained one entry per run
 * this process had ever seen and gave none of it back, for the life of the app.
 *
 * This bound covers the runs that REACH a terminal event. `MAX_RETAINED_LIVE_RUNS` is the other arm,
 * and it is not a refinement of this one: a run that never terminates is never sealed, so no cut this
 * bound makes can ever reach it, and that population grows with the machine's lifetime exactly the way
 * this one used to. Between them they are what makes retention here bounded at all.
 *
 * A terminal, hidden, sealed run is the one class that can be dropped without changing an answer,
 * because it can never become listable again: `isListable` re-opens only on `visibility === 'visible'`
 * and `applyVisibility` refuses to promote a run that has ended. So the projection a surface would
 * ask for is one no surface can reach. Anything that DOES ask afterwards — a later envelope, a REST
 * read, a replay — takes `applyEvent`'s unknown-run arm and re-adopts it from the store, which is the
 * same path a run created by another writer already takes.
 *
 * A run that still OWNS a tab is never dropped whatever its status, because dropping it would drop
 * its rows from the tab index too, and a tab with no owner is the human's (law 4). That is a fact
 * about ownership, not about memory, so it outranks the bound.
 *
 * Five hundred rather than a round thousand for no deeper reason than that no surface here names more
 * than a page of runs and the projections are kept for `list()`, the history read. The bound is on the
 * COUNT and not on bytes because a projection's size is a function of the task string, which the
 * agent writes and this process cannot bound.
 */
export const MAX_RETAINED_SEALED_RUNS = 500;

/**
 * How far past the bound the sealed set is allowed to drift before it is cut back to it.
 *
 * The cut chooses what to drop by the run's OWN `createdAt` rather than by the order this process
 * happened to file it, and that is not a refinement — filing order is wrong in the direction that
 * matters. `hydrate` pages the listing NEWEST-FIRST, so an eviction that dropped the
 * least-recently-filed run would drop the newest finished run on the machine and keep the oldest five
 * hundred, which is the opposite of what any history read wants. Live folding files in the other
 * order again, so no single filing rule is right for both producers; the run's birth is right for
 * both, because it is a fact about the run rather than about the walk that found it.
 *
 * Ordering by it costs a sort, so the cut is BATCHED rather than run per sealed run: at the bound a
 * per-run sort is ~500 log 500 every time a run ends, which is nothing, and at boot it is that once
 * per hydrated run — the 10,000-run shape that already measured 1.3 s of nothing but map deletion in
 * `tabsByRun`'s note. The slack turns that into one cut per hundred, on the thread that paints, for a
 * hundred extra projections held.
 *
 * So the real ceiling on retained sealed runs is `MAX_RETAINED_SEALED_RUNS + SEALED_EVICTION_SLACK`,
 * and the bound this class actually promises is that ceiling, not the round number in it.
 */
export const SEALED_EVICTION_SLACK = 100;

/**
 * How many LISTABLE runs this process keeps the projection of — the other half of the retention bound.
 *
 * `MAX_RETAINED_SEALED_RUNS` cuts the `sealed` set, and a run only enters that set once a terminal
 * envelope has been folded for it. Two ordinary populations never produce one:
 *
 *  - a run created over REST. The REST surface appends its `run.created` and nothing afterwards — see
 *    `ADOPT_RETRY_BASE_MS`, whose whole point is that such a run has no later envelope — so it is
 *    permanently `running`.
 *  - a run whose terminal append was truncated by a force-quit past the shutdown deadline. There is no
 *    reaper behind that, so the log ends without a verdict and the run is `running` forever.
 *
 * Both are listable, so `reindex` files them in `live` and nothing ever takes them out: `live` and
 * `logs` grew with the machine's lifetime population of them, `hydrate` reloaded every one at each
 * boot with no status filter, and the three fan-out listeners walked the whole set at up to one
 * fan-out per frame on the thread that paints. The measured cost in `listLive`'s note — 4.6 MB and
 * 7 ms of a 16 ms frame at 10,000 runs — was taken against terminal runs, and this population re-buys
 * precisely it, because narrowing the walk to `live` cannot exclude a run that never leaves `live`.
 *
 * So the same cut, on the same rule, over the other set: by the run's own `createdAt`, batched by a
 * slack, with the exemptions below outranking the number. Anything dropped re-adopts from the store
 * through `applyEvent`'s unknown-run arm the moment something asks — the same path a run created by
 * another writer already takes, and the same reason dropping a sealed run is safe.
 *
 * Five hundred for the reason the sealed bound is five hundred: no surface here names more than a page
 * of runs. It is deliberately NOT smaller than the sealed bound even though a live run is the more
 * consequential one to drop, because the two populations are answered by the same surfaces and a
 * machine that is genuinely running five hundred concurrent runs has a scheduling problem rather than
 * a retention one.
 */
export const MAX_RETAINED_LIVE_RUNS = 500;

/**
 * How far past `MAX_RETAINED_LIVE_RUNS` the live set may drift before it is cut back — the same trade
 * `SEALED_EVICTION_SLACK` records, for the same reason: the cut orders by birth, ordering costs a
 * sort, and a per-run sort at boot is that sort once per hydrated run.
 *
 * It does a second job here that it does not do for `sealed`. The exemptions below can pin the set
 * above the bound with nothing left to drop, and a cut that cannot reach the bound must not re-sort on
 * every subsequent add — see `liveHighWater`, which advances by exactly this much each time that
 * happens, so the amortised cost of a pinned set is one sort per slack rather than one per run.
 */
export const LIVE_EVICTION_SLACK = 100;

/**
 * How many runs a whole boot will hydrate, across every page.
 *
 * Derived from what retention can HOLD rather than chosen, because a page past that point is read,
 * parsed, retained and then evicted by the cut at the end of `hydrate` — work whose entire product is
 * thrown away. The listing is newest-first and both cuts drop the oldest-born, so the runs a longer
 * boot would reach are exactly the ones the cuts would then discard.
 *
 * This is the bound `MAX_HYDRATION_PAGES` was standing in for and could not be. That constant is a
 * spin guard on a store that returns a cursor forever; it is `DEFAULT_LIST_LIMIT × 200` = 10,000 runs,
 * which is eight times what this process is willing to keep, and on the projection branch every one of
 * those pages was an uncharged `listRuns` — K-82-1 measured one 50-run page of it at 1,109 ms in the
 * child that serialises every other read during boot.
 */
export const MAX_BOOT_HYDRATION_RUNS =
  MAX_RETAINED_LIVE_RUNS + LIVE_EVICTION_SLACK + MAX_RETAINED_SEALED_RUNS + SEALED_EVICTION_SLACK;

/**
 * How many characters the projection-only pages of a boot may make the store READ.
 *
 * `MAX_BOOT_HYDRATION_CHARS` bounds the log branch, and the projection branch was the door beside it
 * that nothing metered: `hydrateProjectionPage` was a bare `store.listRuns` with no charge at all, so
 * the branch the char allowance falls through to was itself free. A `listRuns` page is not cheap —
 * it fully projects `limit + 1` runs, and a projection reads every `tab.attached`/`tab.detached` row
 * the run has ever written, deliberately unbounded per run (`src/studio/run-store.ts`'s
 * `PROJECTION_EVENT_TYPES` note). Free × `MAX_HYDRATION_PAGES` is the same multiplication the log
 * branch's allowance was added to remove, one branch over.
 *
 * Pinned to the log branch's own allowance: the projection tail of a boot may cost what one frame
 * costs, never what two hundred do. Charged by what the STORE reports it read (`ListRunsResult`'s
 * `charsSpent`) rather than by what came back, for the reason `RunLogPage.eventsSpent` records — the
 * expensive rows are the ones a projection condenses away, so the answer's size is silent about them.
 */
export const MAX_BOOT_PROJECTION_CHARS = MAX_BOOT_HYDRATION_CHARS;

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
  /** What that projection dropped to fit the store's page budget. See `RunLogEntry.projectionOmitted`. */
  projectionOmitted?: { pendingDecisions: number };
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
  /**
   * The character allowance for this hydration's READS, defaulting to `MAX_BOOT_HYDRATION_CHARS`.
   *
   * Injectable for the same reason as `eventBudget`, and it is the one a condensed corpus needs: the
   * defect this bounds is invisible to an event allowance, so an arm that can only force the event
   * one cannot reach it.
   */
  charBudget?: number;
  /**
   * The character allowance for this hydration's PROJECTION-only pages, defaulting to
   * `MAX_BOOT_PROJECTION_CHARS`. Separate from `charBudget` because it gates a different branch: the
   * projection pages are the ones taken once `charBudget` is already spent, so a single allowance
   * shared between them could only ever be exhausted before the second branch made its first call.
   */
  projectionCharBudget?: number;
  /**
   * How many runs this hydration may take in total, defaulting to `MAX_BOOT_HYDRATION_RUNS`.
   *
   * Injectable for the same reason as the other two, and it is the one a CHEAP corpus needs: a page of
   * short runs spends almost nothing of either character allowance, so neither of them can stop a boot
   * that is long rather than heavy.
   */
  runBudget?: number;
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
   * The tail seq at which each condensed run last had a re-read issued for it.
   *
   * Two things ask. `withoutExpiredDecisions` infers a status, and a condensed run asks the store for
   * the real one rather than letting the guess stand; and a boot projection that reported dropped
   * pending cards (`RunLogEntry.projectionOmitted`) is short by the store's own admission, so `retain`
   * asks for the rest. Once a run stays condensed across that re-read, asking again at the same tail
   * cannot learn anything the last answer did not carry — and, if the store's clock disagrees about a
   * card by a hair, each answer would narrow again and ask again forever. The tail moving is what
   * makes a new answer possible, so the tail is what re-opens the question.
   */
  private readonly statusRereads = new Map<string, number>();
  /**
   * The runs a surface could still render, so `listLive` walks what it answers with rather than
   * everything this process has ever held.
   *
   * Three listeners call `listLive` on every fan-out — the state push, the tray menu and the
   * presentation controller — at up to one fan-out per frame, on the thread that paints, and the walk
   * was over `logs`, which grows with the machine's LIFETIME run count. So the cost of watching one
   * live run was a function of how many runs had finished beside it.
   *
   * A candidate set rather than an exact one, and pruned on the read. It can only ever be too LARGE:
   * listability is `!terminal || visible`, `applyVisibility` refuses to promote a terminal run, and
   * the clock cannot move either input — `withoutExpiredDecisions` only downgrades `needs_you` to
   * `running`, both listable. So a run leaves this set once and never re-enters except by a replay,
   * which goes through `retain` and re-adds it. Nothing is ever missed by pruning late; the walk is
   * amortised O(1) per run instead of O(retained runs) per fan-out.
   *
   * The set is BOUNDED as well as narrow — `MAX_RETAINED_LIVE_RUNS`. Narrowing alone was not enough:
   * a run that never terminates never leaves the set, so for the two populations that produce one the
   * walk was over the machine's lifetime count again.
   */
  private readonly live = new Set<string>();
  /**
   * The size the live set has to reach before it is worth trying to cut again — see `evictLive`.
   *
   * Zero whenever the last cut reached the bound, which is the ordinary case and the one where the
   * plain slack decides. It is only ever raised when the cut was refused by the exemptions, which is a
   * state that does not fix itself: without this, a set pinned above the bound by six hundred tabbed
   * runs would sort itself on every single add for the life of the app.
   */
  private liveHighWater = 0;
  /**
   * The terminal, unwatched, sealed runs — the candidates for `MAX_RETAINED_SEALED_RUNS`.
   *
   * A `Set` because membership is asked on every fold and a run is added exactly once. Deliberately
   * NOT the eviction order: which of these goes is decided by the run's own `createdAt` at the cut,
   * for the reason `SEALED_EVICTION_SLACK` records — filing order is newest-first at boot and
   * oldest-first while folding, so it is wrong in one direction whichever way it is read.
   */
  private readonly sealed = new Set<string>();
  /**
   * §7.3's session link, read the other way: which run a daemon session spawned.
   *
   * `runForSession` walked every run this process held and asked each for its link, and it is asked
   * once per session per `studio_list` and on every approval notice — a second O(lifetime runs) scan
   * beside `listLive`'s. Written from the same `run.created` fact `sessionId` is replayed from, in
   * `retain`, so it is derived rather than a second account of the linkage.
   *
   * FIRST writer wins, which is the answer the scan gave: it returned the first run in insertion
   * order holding the link, so a second run reusing one session never shadowed the first. The entry
   * is dropped only when the run it names is evicted.
   */
  private readonly runsBySession = new Map<string, string>();
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
  /**
   * A refused adoption: which attempt its chain is on, and how to cancel the one it has scheduled.
   *
   * Keyed by run, so a burst of failures for one run is one chain rather than one per envelope, and
   * so the attempt count survives across attempts — that count is the whole bound. An entry is left
   * in place once the chain is exhausted (see `scheduleRetry`) and removed only by `clearRetry`,
   * which runs the moment the run is materialized by ANY path.
   */
  private readonly adoptRetries = new Map<string, { attempt: number; stop: () => void; opts: { replace?: boolean } }>();
  /** One run-level write at a time per run — see `queueForRun`. */
  private readonly runOps = new Map<string, Promise<unknown>>();
  /** One ownership change at a time per TAB — see `queueForTab`. */
  private readonly tabOps = new Map<string, Promise<unknown>>();
  /**
   * Attach appends still on the wire, per RUN — the one-directional barrier `applyEndRun` waits on so a
   * tab cannot become owned after its run's terminal event. Not a lane: the tab lane still orders this
   * write against the same tab's detach, and joining the two lanes would deadlock. See `applyAttach`.
   */
  private readonly attachesInFlight = new Map<string, Set<Promise<void>>>();
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
    // The reachability signal `ADOPT_RETRY_BASE_MS` says does not exist. It does now — see
    // `RunStoreClient.onReady` and `rearmExhaustedAdoptions`.
    this.store.onReady?.(() => this.rearmExhaustedAdoptions());
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
    // A pending re-adoption counts for the same reason: it would go to a broker this process is
    // done with and fan its result out into listeners that have already been torn down.
    for (const { stop } of this.adoptRetries.values()) stop();
    this.adoptRetries.clear();
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
    // The allowances for the WHOLE hydration, not for each page — see `MAX_BOOT_HYDRATION_EVENTS`
    // (what is retained) and `MAX_BOOT_HYDRATION_CHARS` (what is read). Both, because neither alone
    // bounds a boot: a condensed run costs the store a full read and retains nothing, so on the event
    // allowance alone it is free, and a corpus of them keeps this loop on the log branch for every
    // page while handing the store a freshly reset per-call budget each time.
    let eventsLeft = opts.eventBudget ?? MAX_BOOT_HYDRATION_EVENTS;
    let charsLeft = opts.charBudget ?? MAX_BOOT_HYDRATION_CHARS;
    // The projection branch's own allowances. It used to have none of either — `hydrateProjectionPage`
    // was a bare `listRuns` with no charge — so the branch that exists to be the CHEAP one was the only
    // unmetered call in the loop, taken for up to `MAX_HYDRATION_PAGES` pages in a row.
    let projectionCharsLeft = opts.projectionCharBudget ?? MAX_BOOT_PROJECTION_CHARS;
    let runsLeft = opts.runBudget ?? MAX_BOOT_HYDRATION_RUNS;
    // EVERY page, not the first one. This called `loadLogs()` with no options, which takes
    // `DEFAULT_LIST_LIMIT` runs and drops the `nextCursor` the store hands back with them — so a
    // machine with fifty-one runs booted the app showing fifty, and the fifty-first stayed invisible
    // until it happened to emit, because nothing calls `hydrate` after boot.
    //
    // `MAX_HYDRATION_PAGES` stays as the spin guard it was described as; `runsLeft` is the bound that
    // actually stops an ordinary boot, because it is the one derived from what retention can hold.
    for (let page = 0; page < MAX_HYDRATION_PAGES && runsLeft > 0; page++) {
      const pageOpts = cursor ? { cursor } : {};
      let nextCursor: string | undefined;
      if (eventsLeft > 0 && charsLeft > 0) {
        nextCursor = await this.hydrateLogPage(pageOpts, (runs, events, chars) => {
          runsLeft -= runs; eventsLeft -= events; charsLeft -= chars;
        });
      } else {
        // Checked before the call and not after it, so the page that would overrun is never made.
        if (projectionCharsLeft <= 0) break;
        nextCursor = await this.hydrateProjectionPage(pageOpts, (runs, chars) => {
          runsLeft -= runs; projectionCharsLeft -= chars;
        });
      }
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    // The cuts with no slack — see `evictSealed` and `evictLive`. The pages arrived newest-first, so
    // whatever is left in the slack at the end of a boot is the oldest run on the machine rather than
    // a recent one.
    this.evictSealed(true);
    this.evictLive(true);
    this.emit();
  }

  /**
   * One boot page WITH envelopes, charging what the STORE SPENT against the hydration's allowances.
   *
   * Not what arrived. A condensed entry arrives with no envelopes and cost the store a full read, so
   * charging `events.length` charged zero for the most expensive runs on the page — see
   * `RunLogPage.eventsSpent`.
   *
   * The fallback is `events.length` and no characters, which is exact for the only store that omits
   * the report: `loadLogs`'s own listing-plus-read path materializes every log it returns and
   * condenses nothing, so there what arrived IS what was read.
   */
  private async hydrateLogPage(opts: ListRunsOptions, charge: (runs: number, events: number, chars: number) => void): Promise<string | undefined> {
    const page = await this.loadLogs(opts);
    for (const entry of page.entries) this.retain(entry.facts, entry.events, entry);
    charge(
      page.entries.length,
      page.eventsSpent ?? page.entries.reduce((n, entry) => n + entry.events.length, 0),
      page.charsSpent ?? 0,
    );
    return page.nextCursor;
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
   *
   * CHARGED, which it was not. "Cheaper than the log branch" is not "free": the store fully projects
   * every run on the page, and a projection reads every tab row the run has ever written with no
   * per-run bound. So this branch is metered on the same rule as the other one — by what the STORE
   * reports it READ, never by what came back, because the rows that cost the most are exactly the ones
   * a projection folds away. A store that reports nothing is charged what it shipped instead, which is
   * the honest floor for a binding with no meter and is never zero for a non-empty page.
   */
  private async hydrateProjectionPage(opts: ListRunsOptions, charge: (runs: number, chars: number) => void): Promise<string | undefined> {
    const { runs, nextCursor, charsSpent } = await this.store.listRuns(opts);
    for (const run of runs) this.retain(factsOf(run), [], { lastSeq: run.lastSeq, projection: run });
    charge(runs.length, charsSpent ?? JSON.stringify(runs).length);
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
   *
   * `stopAfter` bounds the WHOLE read rather than one page of it, and it is the caller's answer to
   * "what would I do with more than this": `replayOnce` passes the retention bound, so a log past it
   * stops being paged the moment that is known instead of being read to the end and then thrown away.
   * A read that stops early returns MORE than `stopAfter` — one page more — so the caller can tell
   * "exactly at the bound" from "past it" without a second read.
   */
  private async readLog(runId: string, since = 0, stopAfter = Number.POSITIVE_INFINITY): Promise<RunEvent[]> {
    const events: RunEvent[] = [];
    let cursor = since;
    for (;;) {
      const page = await this.store.eventsSince(runId, cursor, REPLAY_PAGE_SIZE);
      if (page.length === 0) return events;
      for (const event of page) events.push(event);
      if (events.length > stopAfter) return events;
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
    // First writer wins, and re-taking the same run's own entry is not a second writer — see
    // `runsBySession`. Written here rather than in `reindex` because this is the only place a session
    // link is ever learned.
    if (typeof sessionId === 'string' && !this.runsBySession.has(sessionId)) this.runsBySession.set(sessionId, facts.id);
    if (opts.projection) this.condense(facts.id, opts.projection);
    else if (events.some((e) => TERMINAL_EVENT_TYPES.has(e.type))) this.seal(facts.id);
    // After the log is in its final shape, never before: a replaced log is a wholesale change of
    // which tabs this run owns, and the projection that answers it is the condensed one when there is
    // one. Cheap here in a way it is not on the fold — a replay is rare, and the projection it costs
    // is memoised for the read that follows it.
    this.indexTabs(facts.id);
    // After `indexTabs`, because a run that owns a tab is never evicted and this is where that becomes
    // known for a replaced log.
    this.reindex(facts.id);
    // Last, once the log is in its final shape: an INCOMPLETE projection is not this run's state, it is
    // the largest answer that fitted one frame. The store said so — see `RunLogEntry.projectionOmitted`
    // — and the only honest response to "there are more cards than I could send" is to go and get
    // them, which is the same re-read `snapshot` and the horizon timer already issue for a condensed
    // run whose status was inferred rather than read. Without it the shortfall was installed as the
    // run's current state on every surface at once.
    //
    // It terminates: the re-read arrives through `replayOnce`, which either materializes the log or
    // recondenses from `getRun`, and NEITHER carries a `projectionOmitted` — only the boot listing's
    // per-page budget can produce one. `rereadCondensed`'s per-tail dedupe is the second stop, so a
    // re-read that lands still short at the same tail is not asked again.
    if ((opts.projectionOmitted?.pendingDecisions ?? 0) > 0) this.rereadCondensed(facts.id);
  }

  /**
   * Re-file one run in the two derived indexes, after anything that could have moved its listability
   * or its status — a replaced log, a folded envelope, a seal.
   *
   * Not a third source of truth: both answers are read off the projection this class already holds,
   * by `isListable`, which is the same one rule every surface narrows with.
   */
  private reindex(runId: string): void {
    const log = this.logs.get(runId);
    if (!log) return;
    // A sealed run's kept projection is the whole answer — its status can never move again and no read
    // can change it, so this costs a map lookup rather than a projection. A run this process is still
    // folding is listable by definition of not being terminal-and-hidden, and asking would project it.
    if (log.kept === undefined || isListable(log.kept)) {
      this.sealed.delete(runId);
      // The cut runs on the ADD and not on every re-file, so an ordinary fold — which re-indexes the
      // same live run on every envelope — costs one `Set.has` rather than a bound comparison and a
      // possible sort. Same shape as the sealed arm below, which is guarded by `sealed.has`.
      if (!this.live.has(runId)) {
        this.live.add(runId);
        this.evictLive();
      }
      return;
    }
    this.live.delete(runId);
    // A run that still holds a tab keeps its rows whatever the bound says — see
    // `MAX_RETAINED_SEALED_RUNS`. It becomes evictable the moment the tab is released, which folds
    // back through here.
    if (this.tabsByRun.has(runId) || this.sealed.has(runId)) return;
    this.sealed.add(runId);
    this.evictSealed();
  }

  /**
   * Cut the sealed set back to the bound, dropping the runs that were BORN earliest — see
   * `oldestFirst` for why birth is the order, and `SEALED_EVICTION_SLACK` for why the cut is batched
   * rather than run once per sealed run.
   *
   * A prefix slice rather than the take-until-enough walk `evictLive` uses, because nothing exempts a
   * sealed run: the two exemptions that can refuse the live cut — holding a tab, being visible — are
   * both states that keep a run OUT of `sealed` in the first place (`reindex`).
   *
   * `force` cuts to the bound with no slack, and `hydrate` ends with one. Without it the slack is not
   * merely slack at boot, it is a hole: the pages arrive newest-first, so the runs still sitting in
   * the slack when the last page lands are the OLDEST on the machine — the hundred this bound most
   * wants gone. Every cut before that one was correct and the tail undid them.
   */
  private evictSealed(force = false): void {
    if (this.sealed.size <= (force ? MAX_RETAINED_SEALED_RUNS : MAX_RETAINED_SEALED_RUNS + SEALED_EVICTION_SLACK)) return;
    for (const runId of this.oldestFirst(this.sealed).slice(0, this.sealed.size - MAX_RETAINED_SEALED_RUNS)) {
      this.sealed.delete(runId);
      this.forget(runId);
    }
  }

  /**
   * Cut the LIVE set back to its bound, on the same rule and with two exemptions that outrank it.
   *
   * The set this cuts is the one `MAX_RETAINED_LIVE_RUNS` describes: runs a surface could still render,
   * which is every run this process holds that has not been sealed. A run that never terminates never
   * reaches `sealed`, so before this existed there was no arm of any kind that could drop one.
   *
   * Unlike the sealed cut, this one can be REFUSED per run, so it walks oldest-first and takes until it
   * has dropped enough rather than slicing a prefix. The two exemptions:
   *
   *  - the run OWNS a tab. Law 4: dropping it drops its rows from the tab index, and a tab with no
   *    owner is the human's. Read from `tabsByRun`, so it costs a map lookup.
   *  - the run is VISIBLE. `run-presentation` decides whether the window is shown by asking `listLive`
   *    whether any run is visible, so evicting a promoted run closes the window over a run that is
   *    still going, with no envelope coming to bring it back — the failure the eviction is supposed to
   *    be invisible against. A condensed run answers from what it kept; anything else is projected,
   *    and only for the candidates this cut actually walks.
   *
   * The walk is what those exemptions cost, and they can pin the set above the bound indefinitely — a
   * machine holding six hundred tabbed runs has nothing this may drop. `liveHighWater` is what keeps
   * that from re-sorting on every subsequent add: a cut that could not reach the bound raises the next
   * cut's trigger by one slack, so the amortised cost stays one sort per `LIVE_EVICTION_SLACK` runs
   * whether or not the cut can do anything.
   */
  private evictLive(force = false): void {
    const trigger = force
      ? MAX_RETAINED_LIVE_RUNS
      : Math.max(MAX_RETAINED_LIVE_RUNS + LIVE_EVICTION_SLACK, this.liveHighWater);
    if (this.live.size <= trigger) return;
    let over = this.live.size - MAX_RETAINED_LIVE_RUNS;
    for (const runId of this.oldestFirst(this.live)) {
      if (over <= 0) break;
      if (!this.evictableLive(runId)) continue;
      // `forget` removes it from `live` as well — see the note there about dropping EVERY row.
      this.forget(runId);
      over--;
    }
    this.liveHighWater = this.live.size > MAX_RETAINED_LIVE_RUNS ? this.live.size + LIVE_EVICTION_SLACK : 0;
  }

  /**
   * May the live cut drop this run? See `evictLive` for why each answer is what it is.
   *
   * A run with no log left is trivially droppable — it is already gone and only the candidate entry
   * remains, which is the state `listLive`'s late prune also handles.
   */
  private evictableLive(runId: string): boolean {
    if (this.tabsByRun.has(runId)) return false;
    const log = this.logs.get(runId);
    if (!log) return true;
    return (log.kept ?? this.snapshot(runId))?.visibility !== 'visible';
  }

  /**
   * The eviction order both cuts use: the run's own birth, oldest first.
   *
   * By birth rather than by when this process filed them, because the two producers file in opposite
   * orders and only one of them is the ordinary case — `SEALED_EVICTION_SLACK` has the argument.
   * `createdAt` is ISO-8601, so string order is chronological order. A run whose facts have already
   * gone sorts first and is dropped first, which is right: there is nothing left to keep.
   */
  private oldestFirst(ids: ReadonlySet<string>): string[] {
    const bornAt = (runId: string): string => this.logs.get(runId)?.facts.createdAt ?? '';
    return [...ids].sort((a, b) => {
      const [x, y] = [bornAt(a), bornAt(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  /**
   * Drop every row this process holds for one run.
   *
   * EVERY row, not just the log: `statusRereads`, the memo, the live candidate, a scheduled horizon
   * and an owed retry are all keyed by run id, and a bound that left any of them would have moved the
   * leak rather than closed it. The session link goes only if it still names this run, so evicting an
   * old run cannot unlink a newer one that reused the session.
   *
   * Nothing observable is lost — see `MAX_RETAINED_SEALED_RUNS` for why this run cannot be asked for
   * — and anything that does ask re-adopts it from the store.
   */
  private forget(runId: string): void {
    const log = this.logs.get(runId);
    for (const tabId of [...(this.tabsByRun.get(runId) ?? [])]) this.disownTab(runId, tabId);
    this.logs.delete(runId);
    this.projected.delete(runId);
    this.statusRereads.delete(runId);
    this.live.delete(runId);
    this.sealed.delete(runId);
    this.horizons.get(runId)?.stop();
    this.horizons.delete(runId);
    this.clearRetry(runId);
    if (log?.sessionId !== undefined && this.runsBySession.get(log.sessionId) === runId) this.runsBySession.delete(log.sessionId);
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
    // The envelope comes off the broker's `run-event` notify, which is JSON cast to `RunEvent` with
    // nothing between the wire and the cast. A missing `seq` is not caught by either comparison
    // below — `undefined <= n` and `undefined > n + 1` are both false — so it folded, set
    // `lastSeq = undefined`, and left gap detection dead for that run with nothing able to heal it:
    // every later comparison against `undefined` is false too, so no gap ever opens again. Routed to
    // a replace-adoption rather than dropped, because an envelope this process cannot place is
    // exactly the case a full re-read answers. Ahead of the unknown-run arm so the internal `fold`
    // path is covered by the same guard.
    if (!Number.isInteger(event.seq)) { void this.adopt(runId, { replace: true }); return; }
    const log = this.logs.get(runId);
    // A run this projection has never seen — created by the REST surface, or by another writer in this
    // process. Folding one mid-stream envelope in would leave a run whose history starts at seq 9, so
    // the whole log is replayed instead. Without this it would stay invisible until the next hydrate,
    // and nothing calls hydrate after boot.
    if (!log) { void this.adopt(runId); return; }
    if (event.seq <= log.lastSeq) return;
    // A gap means an envelope was missed — one that landed while this run was being adopted, or a
    // dropped notify. Appending the newer one anyway would leave a log that silently disagrees with the
    // store, so the run is replayed from scratch instead. Same contract as #46's SSE tail.
    if (event.seq > log.lastSeq + 1) { void this.adopt(runId, { replace: true }); return; }
    // A condensed run has no envelopes to fold INTO, so the envelope is folded onto the projection it
    // keeps instead — see `foldCondensed`. What that refuses still replays, which is the state a
    // sealed run and a short condensed one are both in.
    if (log.kept) {
      if (!this.foldCondensed(runId, log, event)) { void this.adopt(runId, { replace: true }); return; }
      this.reindex(runId);
      this.emit();
      return;
    }
    log.events.push(event);
    log.lastSeq = event.seq;
    this.trackTabOwnership(runId, event);
    this.projected.delete(runId);
    if (TERMINAL_EVENT_TYPES.has(event.type)) this.seal(runId);
    // A live run that has grown past the bound is condensed exactly as a boot read condenses one, so
    // the array stops growing with the run. Nothing trimmed a live log before: `seal` empties it only
    // at a terminal event, and `cost.recorded` is one envelope per browser action by design, so the
    // busiest run on the machine held every envelope it had ever emitted on the thread that paints and
    // re-folded all of them on every memo miss.
    //
    // Routed through `adopt` rather than straight to `recondense` for its in-flight coalescing: the
    // re-condense is a round-trip, envelopes keep arriving while it is on the wire, and each one would
    // otherwise buy its own. Every caller that arrives mid-flight asks for one more pass instead, so a
    // burst costs one read plus one, and the run is condensed by the time it settles.
    else if (this.overBound(runId)) void this.adopt(runId, { replace: true });
    this.reindex(runId);
    this.emit();
  }

  /**
   * Fold one envelope onto the projection a condensed run keeps, instead of asking the store for a
   * fresh one. Returns false when this envelope is not foldable, and the caller replays.
   *
   * SD1 exit-12 bounded a live run's RETENTION by re-condensing at `REMATERIALIZE_MAX_EVENTS`, and
   * accepted "one bounded `getRun` per burst" as the steady state. A burst window is one broker
   * round-trip, so for a STREAM that is a round-trip per envelope, forever: `adopt`'s in-flight
   * coalescing paces the loop at 1/RTT, it does not end it. And the read it paces is not small —
   * `getRun` projects the run, which walks every `tab.attached`/`tab.detached` row the run has ever
   * written plus the pending-card anti-join, on the broker child that serialises every other DB
   * call. The run that pays it is the fifty-thousand-action one that emits a `cost.recorded` per
   * browser action, for 48,000 envelopes.
   *
   * The envelope is at exactly `lastSeq + 1`, so nothing is missing and the projection can move by
   * itself. It moves by `projectRun`'s OWN rules rather than a second copy of them: the four seedable
   * fields are seeded from the kept projection and the two that are not are replayed as the envelopes
   * that produce them (`keptSeed`), so the fold is the same function the store and REST both run.
   * Cost is bounded by the tabs the run HOLDS, and there is no read at all.
   *
   * Three things still buy the round-trip, and each is a state the projection cannot answer from:
   *  - a status-moving type, whose fold needs a `pausedReason` no `Run` carries — `STATUS_FOLD_EVENT_TYPES`
   *  - a terminal run, whose envelopes are gone by design and whose next envelope is out of order anyway
   *  - a run UNDER the bound, which is condensed by a boot page's budget rather than by its own size
   *    and is deliberately re-materialized so it can hold its envelopes and fold the next for free
   *
   * A seq GAP never reaches here: `applyEvent` and `fold` both refuse it above, which is the single-read
   * gap-replay contract this deliberately does not touch.
   */
  private foldCondensed(runId: string, log: RunLog, event: RunEvent): boolean {
    const kept = log.kept;
    if (!kept || isTerminal(kept.status)) return false;
    if (STATUS_FOLD_EVENT_TYPES.has(event.type)) return false;
    if (!this.overBound(runId)) return false;
    // `now` is passed for honesty rather than for effect: the only rules that read it are the card
    // arms and the status fold, and both are excluded above — `status` is seeded, so the fold is not
    // consulted, and expiry stays where it already is, at the read in `snapshot`.
    log.kept = projectRun(log.facts, [...keptSeed(kept), event], this.now(), {
      cost: kept.cost,
      visibility: kept.visibility,
      pendingDecisions: kept.pendingDecisions,
      status: kept.status,
    });
    log.lastSeq = event.seq;
    this.trackTabOwnership(runId, event);
    this.projected.delete(runId);
    return true;
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
    // Already held, and nothing asked for a re-read — so a retry chain owed to an earlier refusal is
    // owed nothing now, whichever path materialized the run (`createRun`, `hydrate`, a later
    // envelope). This is the arm a fired retry lands on when it has been overtaken.
    if (this.logs.has(runId) && !opts.replace) { this.clearRetry(runId); return Promise.resolve(); }
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

  /**
   * One replay, plus what to do when the store refuses it.
   *
   * A refusal is not an answer, so it is re-attempted rather than swallowed — see
   * `ADOPT_RETRY_BASE_MS` for why "a later event retries" was false for the run class this arm
   * exists to catch. Anything that is not a throw is an answer and ends the chain, including the two
   * ways `replayOnce` returns without retaining: the run does not exist in the store, or it has
   * already been materialized by a shorter path. Neither leaves anything owed.
   */
  private async replay(runId: string, opts: { replace?: boolean }): Promise<void> {
    try {
      await this.replayOnce(runId, opts);
    } catch {
      // The store is unreachable; the run is not lost, only unseen — so remember it and ask again.
      this.scheduleRetry(runId, opts);
      return;
    }
    this.clearRetry(runId);
  }

  /**
   * The read itself, and the bound the UNKNOWN-run arm never had.
   *
   * `overBound` above opens `if (!log) return false`, so it can only ever speak for a run this
   * process is already holding — which means no short-circuit was available on the one path that
   * reaches here for a run it is not: `applyEvent`'s unknown-run arm, taken for a run created over
   * REST or by another writer. That path read the ENTIRE log with no total cap and retained every
   * envelope of it. The live-run bound then fired only on the NEXT envelope, so a long run that went
   * quiet after being adopted held its whole log for as long as it stayed quiet — measured at 2,501
   * envelopes retained until an envelope arrived to condense them.
   *
   * So the read is capped at the same bound the fold uses, and a log past it is answered the way boot
   * answers one: with the store's own projection, for one round-trip. The cap is on the read as well
   * as on what is kept, because the frame is what blocks the thread that paints — skipping the
   * retention alone would still have paged and parsed the whole log.
   *
   * The `replace` short-circuit above is untouched: it answers for a log already known to be over the
   * bound, and this answers for one whose length is not known until it has been read.
   */
  private async replayOnce(runId: string, opts: { replace?: boolean }): Promise<void> {
    if (opts.replace && this.overBound(runId)) { await this.recondense(runId); return; }
    const facts = await this.readFacts(runId);
    if (!facts || (this.logs.has(runId) && !opts.replace)) return;
    const events = await this.readLog(runId, 0, REMATERIALIZE_MAX_EVENTS);
    if (this.logs.has(runId) && !opts.replace) return;
    if (events.length > REMATERIALIZE_MAX_EVENTS) { await this.recondense(runId); return; }
    this.retain(facts, events);
    this.emit();
  }

  /**
   * Ask for this run again after a backoff, a bounded number of times.
   *
   * The attempt count is read off the entry rather than reset per call, so a chain that keeps
   * failing walks to the cap and stops. At the cap the entry STAYS — with nothing scheduled — so a
   * later envelope that fails the same way finds an exhausted chain instead of buying a fresh one.
   * `clearRetry` is the only thing that resets it, and it runs whenever the run is materialized.
   */
  private scheduleRetry(runId: string, opts: { replace?: boolean }): void {
    const held = this.adoptRetries.get(runId);
    held?.stop();
    const attempt = (held?.attempt ?? 0) + 1;
    if (attempt > MAX_ADOPT_RETRIES) {
      this.adoptRetries.set(runId, { attempt, stop: () => {}, opts });
      return;
    }
    const delay = Math.min(ADOPT_RETRY_BASE_MS * 2 ** (attempt - 1), ADOPT_RETRY_MAX_MS);
    const stop = this.setTimer(() => { void this.adopt(runId, opts); }, delay);
    this.adoptRetries.set(runId, { attempt, stop, opts });
  }

  /**
   * The store came back — ask again for every run whose chain had already given up.
   *
   * `ADOPT_RETRY_BASE_MS` bounds the COUNT so a permanently dead broker stops rather than spins, and
   * deliberately does NOT let the next envelope re-arm an exhausted chain, because a half-dead broker
   * still fanning notifies out would buy a fresh chain per envelope. That bound is right and it left a
   * hole its own note names: eight attempts is about 62 seconds, and the run class the whole arm
   * exists for — one created over REST, whose only envelope is its `run.created` — has no later
   * envelope at all. A brownout longer than the chain therefore left that run in the store, in REST's
   * answer, and in no surface this app owns until the app was restarted. One log, two answers; law 1.
   *
   * Reachability is the missing signal the note asked for, and it is a strictly narrower trigger than
   * the envelope that was refused: it fires once per respawn rather than once per envelope, so the
   * spin the count bound exists to prevent is not reintroduced. `clearRetry` before the ask, so a
   * chain that fails again starts from attempt one — the store answered since, so this is a new
   * question, not a continuation of the old one. The ORIGINAL opts are replayed, because a gap replay
   * and an unknown-run adoption unwind differently.
   */
  private rearmExhaustedAdoptions(): void {
    for (const [runId, held] of [...this.adoptRetries]) {
      if (held.attempt <= MAX_ADOPT_RETRIES) continue;
      this.clearRetry(runId);
      void this.adopt(runId, held.opts);
    }
  }

  /** This run has an answer — materialized, or known not to exist. Nothing is owed it. */
  private clearRetry(runId: string): void {
    const held = this.adoptRetries.get(runId);
    if (!held) return;
    held.stop();
    this.adoptRetries.delete(runId);
  }

  /**
   * Is this run too long for this process to hold its envelopes? Answered from what is already here —
   * `lastSeq`, which the store told us, or the retained array — so deciding costs no read at all; the
   * read is what the decision is about.
   *
   * It used to open with `kept !== undefined`, which made it a question about how a run BOOTED rather
   * than about how long it is. A run created in this process, or adopted while it was short, has
   * `kept === undefined` for its whole life, so the bound never applied to the one class of run that
   * actually grows: the live one. Both arms ask the same question of the quantity each state can
   * answer it with — a condensed run has no envelopes to count, and a materialized one's `lastSeq` can
   * sit above what it holds after a bounded read.
   */
  private overBound(runId: string): boolean {
    const log = this.logs.get(runId);
    if (!log) return false;
    if (log.kept !== undefined) return log.lastSeq > REMATERIALIZE_MAX_EVENTS;
    return log.events.length > REMATERIALIZE_MAX_EVENTS;
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
   * How many raw envelopes this projection is holding for a run. Zero once the run is terminal, zero
   * for a run whose log was condensed at boot, and zero for a live one that has since grown past
   * `REMATERIALIZE_MAX_EVENTS` — the retention bound is a property callers and tests can actually
   * check, not a comment.
   */
  retainedEventCount(runId: string): number {
    return this.logs.get(runId)?.events.length ?? 0;
  }

  /**
   * How many runs this process holds rows for at all — the quantity `MAX_RETAINED_SEALED_RUNS` bounds.
   *
   * Exposed for the same reason `retainedEventCount` is: "memory is no longer a function of the
   * machine's lifetime run count" is a claim nothing about a projection can show, and a bound that
   * cannot be counted is a comment.
   */
  retainedRunCount(): number {
    return this.logs.size;
  }

  /**
   * The daemon studio session that spawned this run (§7.3's linkage), replayed from `run.created`.
   * A session is how a client connects; a run is the task — so the link is a recorded fact, not a
   * second map for the host to keep in step with the log.
   */
  sessionIdOf(runId: string): string | undefined {
    return this.logs.get(runId)?.sessionId;
  }

  /** The run a session spawned, from the index rather than by sweeping every run — see `runsBySession`. */
  runForSession(sessionId: string): string | undefined {
    return this.runsBySession.get(sessionId);
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
   * The walk is still over `logs` rather than over `live`, and that is now bounded rather than merely
   * narrowed: `logs` holds at most the two retention ceilings plus what their exemptions pin, so this
   * costs a page of runs and not the machine's lifetime population. Before the live ceiling existed the
   * skip was the only thing between this and an unbounded walk, and the skip cannot fire for a run that
   * never terminates — which is the class this walk was most likely to be full of.
   *
   * Narrowing it costs nothing observable. The one caller, `run-decisions`' `settle`, hands whatever
   * it gets back to `resolveDecision`, which refuses on the run lane once the run is terminal —
   * appending a `decision.resolved` after `run.completed` would be an out-of-order fact in an
   * append-only log — so a terminal run was never an answer that could be acted on, only one more
   * projection on the way past. Reverse this the moment some caller needs the run behind a card the
   * log has already closed.
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
   * The newest seq this projection has folded for that run — the FLOOR a lost-reply probe reads from.
   *
   * Taken before an append is attempted, so `resolutionLanded` reads a window that starts strictly
   * below the envelope it is looking for. Without a floor the probe would have to re-materialize the
   * whole log to answer, which is the read every bound in this class exists to avoid.
   */
  lastSeqOf(runId: string): number {
    return this.logs.get(runId)?.lastSeq ?? 0;
  }

  /**
   * Did a resolution for this card actually COMMIT, whatever its reply did?
   *
   * A broker round-trip can fail after the write landed — the append committed and the reply was lost
   * — and a retry that cannot tell that apart appends a second `decision.resolved` for one card. The
   * projection cannot answer it: `pendingDecisions` drops a card at its two-minute deadline as well
   * as at its resolution, so "no longer pending" conflates a resolved card with an expired one. The
   * durable log distinguishes them, and it is the only thing that does.
   *
   * Paged rather than capped, because a truncated page that happens to stop one envelope short of the
   * resolution would answer "no" and buy the double-append this exists to prevent. It stops on an
   * EMPTY page rather than a short one, for the reason `REPLAY_PAGE_SIZE` records: a short page is
   * what a server-side per-frame ceiling looks like from here, and stopping on it would truncate the
   * window. A seq that failed to advance ends the loop too, so a stalled store cannot spin it.
   */
  async resolutionLanded(runId: string, decisionId: string, since: number): Promise<boolean> {
    let from = since;
    for (;;) {
      const events = await this.store.eventsSince(runId, from, REPLAY_PAGE_SIZE);
      for (const event of events) {
        if (event.type === 'decision.resolved' && String(event.payload.decisionId) === decisionId) return true;
      }
      const newest = events[events.length - 1];
      if (!newest || newest.seq <= from) return false;
      from = newest.seq;
    }
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
    // Refused past the terminal event, the same way `applyVisibility`, `applyRequestDecision` and
    // `applyResolveDecision` are (`wigolo-studio-run` issue 112). This was the one lifecycle write with
    // no such guard, and the store below checks only that the run row exists — so an attach on a run
    // that had already ended committed, and the append-only log came out saying a cancelled run owns a
    // page. `agentVisibleTabs` then lists that tab and `promote()` focuses it, and no replay repairs
    // it. A missing projection is refused for the reason `applyResolveDecision` records for its own:
    // a run this process is not holding cannot be shown to be open, and law 4's ownership read below is
    // decided on that same projection, so appending anyway is a blind write.
    const run = this.snapshot(runId);
    if (!run) throw new RunNotOpenError(runId, 'unknown');
    if (isTerminal(run.status)) throw new RunNotOpenError(runId, 'ended');
    const owner = this.ownerOf(tabId);
    if (owner === runId) return;
    if (owner !== undefined) throw new TabOwnedError(tabId, owner);
    // The url is narrowed to its ORIGIN here, at the constructor, rather than at any call site: the run
    // log is append-only with no prune path by design, and is served over `GET /v1/runs/{id}/events` and
    // the SSE tail, so a query string that gets in is a secret stored forever and handed to every client
    // past the REST gate. The agent supplies this url (`studio_open`'s startUrl), and an agent handed a
    // magic link is the ordinary case, not the adversarial one. Same rule the audit path already applies.
    //
    // The append is PUBLISHED while it is on the wire (`attachesInFlight`), because the guard above is a
    // check-then-act and the lanes cannot close the other half of it: this write is ordered per TAB and
    // the terminal event is ordered per RUN, so an attach whose append is still travelling when
    // `endRun` decides has passed a projection `run.cancelled` is about to move. Joining the two lanes
    // would deadlock — `applyEndRun` holds the run lane while awaiting the per-tab lanes its detaches
    // take — so `applyEndRun` waits for what is registered here instead, one-directionally.
    const landing = (async () => {
      const event = await this.store.appendEvent(runId, {
        actor: { kind: 'agent', driver: 'studio' },
        type: 'tab.attached',
        payload: { tabId, ...(url ? { url: originOnly(url) } : {}) },
      });
      await this.fold(runId, event);
    })();
    const inFlight = this.attachesInFlight.get(runId) ?? new Set<Promise<void>>();
    inFlight.add(landing);
    this.attachesInFlight.set(runId, inFlight);
    try {
      await landing;
    } finally {
      inFlight.delete(landing);
      if (inFlight.size === 0) this.attachesInFlight.delete(runId);
    }
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
   * Run one write after every write already queued for THAT run.
   *
   * The same shape as `queueForTab`, for the same reason and about the run rather than the tab: every
   * write on this lane is a check-then-act across an await, the check reads the PROJECTION, and the
   * append is a round-trip. `endRun` and `resolveDecision` are the pair that races — a two-minute
   * auto-deny firing while `run.completed` is still on the wire read a not-yet-terminal projection,
   * passed, and the store committed its `decision.resolved` AFTER the terminal event. That is an
   * out-of-order fact in an append-only log: no replay repairs it, and every surface that reads the
   * log afterwards — here, over REST, in a replay, in the audit — sees a run answering a card it had
   * already finished.
   *
   * ONE lane for every kind, never one each. Two lanes would serialise each kind against itself and
   * leave that pair exactly as unserialised as no lane at all — the same lesson `queueForTab` records
   * for attach against detach. `setVisibility`'s idempotence check and its already-ended refusal are
   * the same check-then-act against the same terminal append, so they ride here too.
   *
   * Per run, so one run's slow append never holds another's up. The rejection handler is the same
   * call as the fulfilment one: a queued write runs whether the one before it committed or refused,
   * because a refusal changed nothing for it to be behind.
   */
  private queueForRun<T>(runId: string, op: () => Promise<T>): Promise<T> {
    const queued = (this.runOps.get(runId) ?? Promise.resolve()).then(op, op);
    const tail = queued.then(
      () => { if (this.runOps.get(runId) === tail) this.runOps.delete(runId); },
      () => { if (this.runOps.get(runId) === tail) this.runOps.delete(runId); },
    );
    this.runOps.set(runId, tail);
    return queued;
  }

  /**
   * Terminal transition: release the run's tabs first, so the log never ends owning a dead tab.
   *
   * On the run lane, which is what makes the terminal event an ORDERING every other write on the run
   * is decided against rather than a fact they each race — see `queueForRun`. The tab detaches inside
   * it take the per-tab lanes, which nothing on this lane holds, so the two never wait on each other.
   *
   * The membership read is deliberately taken here and not inside the lane: it names the tabs to TRY,
   * and `applyDetach` decides per tab, on the queue, whether there is still anything to release. A tab
   * a human closed in the meantime is folded to a no-op there rather than written twice here.
   */
  endRun(runId: string, terminal: RunTerminal, detail?: string): Promise<void> {
    return this.queueForRun(runId, () => this.applyEndRun(runId, terminal, detail));
  }

  private async applyEndRun(runId: string, terminal: RunTerminal, detail?: string): Promise<void> {
    // A run ends once. A second terminal append is the same out-of-order durable fact the writes above
    // refuse, from the other side, and the quit path reaches it: `shutdown()` cancels a run whose
    // `open()` is still in flight, and that open's rollback then ends the run it created. Decided here,
    // on the run lane, so the check is serialised against the terminal append rather than racing it —
    // and silently, because every caller of this is a teardown that wants the run over, not a report.
    const current = this.snapshot(runId);
    if (current && isTerminal(current.status)) return;
    // The barrier `applyAttach` registers for. Waited on BEFORE the membership read below, so a tab
    // whose attach was travelling when this ran is a tab this release can see — without it the read
    // finds nothing, the terminal event lands, and the attach then commits behind it, leaving a
    // cancelled run owning a page. `allSettled`, because a refused attach owes this nothing.
    const landing = this.attachesInFlight.get(runId);
    if (landing) await Promise.allSettled([...landing]);
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
    // Serialised per run, because the checks below are against the PROJECTION: two clicks on the same
    // menu item both read "hidden" before either append lands, and the log gets two promotes for one
    // transition. A human double-clicking is the ordinary way to produce that. The run lane it shares
    // with `endRun` is also what makes the already-ended refusal below true rather than likely.
    return this.queueForRun(runId, () => this.applyVisibility(runId, next, by, surface));
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

  /**
   * A card the human has to answer, recorded on the run it blocks (law 10, and `needs_you`'s source).
   *
   * On the run lane and refused past the terminal event for the same reason its answer is — the same
   * closing session that races a resolution races the card that raised it, and a `decision.requested`
   * landing after `run.completed` is worse than an out-of-order envelope: it is the one event that
   * projects to `needs_you`, so a finished run would ask for a human nobody can answer to.
   */
  requestDecision(runId: string, input: { decisionId: string; kind: string; prompt: string }): Promise<void> {
    return this.queueForRun(runId, () => this.applyRequestDecision(runId, input));
  }

  private async applyRequestDecision(runId: string, input: { decisionId: string; kind: string; prompt: string }): Promise<void> {
    const run = this.snapshot(runId);
    if (!run || isTerminal(run.status)) return;
    const event = await this.store.appendEvent(runId, {
      actor: { kind: 'agent', driver: 'studio' },
      type: 'decision.requested',
      payload: { decisionId: input.decisionId, kind: input.kind, prompt: input.prompt },
    });
    await this.fold(runId, event);
  }

  /**
   * The card's answer, refused where the refusal is SERIALISED against the terminal append rather
   * than at a call site that races it.
   *
   * This used to append unconditionally, and the refusal lived in `run-decisions`' `settle`, which
   * read `snapshot(runId)?.status` and then awaited this. Between that read and this append sits a
   * round-trip, so the two-minute auto-deny of a card whose run was closing read a projection
   * `endRun`'s append had not moved yet, passed, and wrote `decision.resolved` after
   * `run.completed` — the exact out-of-order durable fact the check was there to prevent. A guard on
   * one side of a race is not a guard.
   *
   * Deciding it here puts the read and the append on the run lane together (`queueForRun`), so the
   * projection this reads is one no in-flight terminal append can be about to move: either `endRun`
   * already ran and this refuses, or it is still queued and runs after. Nothing downstream has to
   * remember to notify anybody, and every path in — timer, human, broker — is covered by one check.
   */
  resolveDecision(runId: string, decisionId: string, outcome: 'approved' | 'denied' | 'auto_denied', by: 'human' | 'system'): Promise<void> {
    return this.queueForRun(runId, () => this.applyResolveDecision(runId, decisionId, outcome, by));
  }

  private async applyResolveDecision(runId: string, decisionId: string, outcome: 'approved' | 'denied' | 'auto_denied', by: 'human' | 'system'): Promise<void> {
    const run = this.snapshot(runId);
    // A run this process is not holding cannot be shown to be still open. The caller that used to
    // decide this defaulted a missing status to `running` — a guard that passed hardest exactly where
    // it knew least, and appended blind to a run that had fallen out of the projection entirely.
    if (!run) return;
    // The run is over, and the log says so. A resolution after the terminal event is out of order in a
    // log with no prune path, and on a condensed run it forces a full re-read to absorb an envelope
    // that should not exist.
    if (isTerminal(run.status)) return;
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
   * comparison here instead of a `snapshot` call. A terminal run that is NOT sealed (adopted
   * mid-flight, say) falls through to the correct arm rather than to a wrong answer.
   *
   * The WALK is over the `live` candidate set rather than over every run this process retains. That
   * narrowing is worth exactly what the set is BOUNDED by, and on its own it was worth nothing for the
   * two populations that never terminate: a run with no terminal envelope never leaves `live`, so the
   * walk was over the machine's lifetime count of them and the cost this note measures was re-bought in
   * full. `MAX_RETAINED_LIVE_RUNS` is what makes the sentence true — the walk costs a page of runs,
   * never what the machine has ever run. Both narrowings are needed and neither replaces the other:
   * the set bounds how many runs
   * are visited, the log check bounds what visiting one costs. A run that has left the set is dropped
   * from it HERE, on the read, rather than at the fold that made it non-listable — a candidate can
   * only ever be stale in the one direction, so a late prune answers identically and the fold stays a
   * `Set.add`.
   */
  listLive(): RunSummary[] {
    const out: RunSummary[] = [];
    const stale: string[] = [];
    for (const id of this.live) {
      const log = this.logs.get(id);
      if (!log || (log.kept && !isListable(log.kept))) { stale.push(id); continue; }
      const run = this.snapshot(id)!;
      if (!isListable(run)) { stale.push(id); continue; }
      out.push(summaryOf(run));
    }
    for (const id of stale) this.live.delete(id);
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
   * Replace a condensed run's kept projection with one read from the store, at most once per tail.
   *
   * Called for the two ways a kept projection can be less than the run — a status this process
   * INFERRED from the clock, and a card list the store told us it had to cut — because the repair is
   * the same in both: the log is authoritative and it is one round-trip away. See `statusRereads` for
   * why the tail is the dedupe key.
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
