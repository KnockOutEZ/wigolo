import { projectRun, type CreateRunInput, type ListRunsOptions, type ListRunsResult, type Run, type RunEvent, type RunEventInput, type StoredRunFacts } from 'wigolo/studio';
import type { BrokerClient } from './broker-client';

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

/** One run's stored facts and the envelopes that project it — what a replay needs, and nothing else. */
export interface RunLogEntry {
  facts: StoredRunFacts;
  events: RunEvent[];
}

/** The store, as this process reaches it. Broker-backed in the app; the port exists so tests can bind. */
export interface RunStoreClient {
  createRun(input: CreateRunInput): Promise<Run>;
  appendEvent(runId: string, event: RunEventInput): Promise<RunEvent>;
  getRun(runId: string): Promise<Run | undefined>;
  /**
   * The filter/paging options exist for the REST surface (`GET /v1/runs?status=&limit=&cursor=`),
   * which this process now serves as the live store owner. The view-model itself always wants the
   * whole snapshot and passes nothing.
   */
  listRuns(opts?: ListRunsOptions): Promise<ListRunsResult>;
  eventsSince(runId: string, since?: number, limit?: number): Promise<RunEvent[]>;
  onRunEvent(handler: (runId: string, event: RunEvent) => void): void;
  /**
   * The whole boot page — facts and events together — in one round-trip, rather than a listing
   * followed by a read per run. Optional because this is a port: a store that does not offer it is
   * still correct, and `hydrate` falls back to the listing plus a concurrent read per run.
   */
  listRunLogs?(opts?: ListRunsOptions): Promise<RunLogEntry[]>;
  /**
   * Does this run exist, without projecting it? `getRun` replays the whole log to answer, which is
   * what the SSE route's paged replay exists to avoid. Optional for the same reason as `listRunLogs`.
   */
  runExists?(runId: string): Promise<boolean>;
}

export function createBrokerRunStoreClient(broker: BrokerClient): RunStoreClient {
  return {
    createRun: (input) => broker.call<Run>('runCreate', { input }),
    appendEvent: (runId, event) => broker.call<RunEvent>('runAppend', { runId, event }),
    getRun: (runId) => broker.call<Run | undefined>('runGet', { runId }),
    listRuns: (opts = {}) => broker.call<ListRunsResult>('runList', opts),
    listRunLogs: (opts = {}) => broker.call<RunLogEntry[]>('runListLogs', opts),
    eventsSince: (runId, since = 0, limit) => broker.call<RunEvent[]>('runEventsSince', { runId, since, limit }),
    runExists: (runId) => broker.call<boolean>('runExists', { runId }),
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

/** What a surface needs to name a run. Everything on it is projected; nothing is stored here. */
export interface RunSummary {
  id: string;
  task: string;
  status: Run['status'];
  tabIds: string[];
  visibility: Run['visibility'];
}

interface RunLog {
  facts: StoredRunFacts;
  /** The envelopes this projection is folding. Emptied once `final` is set — see `seal`. */
  events: RunEvent[];
  /**
   * The highest seq folded in. Tracked beside the events rather than read off their tail, because a
   * sealed run has no tail left and still has to reject an envelope it has already seen.
   */
  lastSeq: number;
  /** Replayed from `run.created` once, rather than searched for on every `runForSession` sweep. */
  sessionId?: string;
  /** A terminal run's last projection, kept in place of the events that produced it. */
  final?: Run;
}

export class RunViewModel {
  /** A replica of each live run's log, refillable at any time from the store. Not a second source of truth. */
  private readonly logs = new Map<string, RunLog>();
  /** Memoised `projectRun` output, dropped whenever a run's events change. A pure function's cache. */
  private readonly projected = new Map<string, Run>();
  private readonly listeners = new Set<() => void>();
  /**
   * Replays in flight, so a burst of events for one run causes a single replay — and so a caller that
   * needs the projection current before it resolves can await the replay somebody else started.
   */
  private readonly adopting = new Map<string, Promise<void>>();
  /** One presentation transition at a time per run — see `setVisibility`. */
  private readonly transitions = new Map<string, Promise<void>>();

  constructor(private readonly store: RunStoreClient) {
    this.store.onRunEvent((runId, event) => this.applyEvent(runId, event));
  }

  /**
   * Fires whenever the projection moves. The tab strip needs this on top of `TabManager.onChange`:
   * detaching is an async append, so a tab closing and its run releasing it are two separate moments
   * and only the second one carries the new ownership.
   */
  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  /**
   * Replay every run from the store. Safe to call repeatedly — it replaces what it holds.
   *
   * A run the listing did not name is KEPT rather than dropped: the listing is a snapshot, and a run
   * created after it was taken would otherwise be discarded here and stay invisible until it happened
   * to emit again. Runs are never deleted, so "absent from the listing" only ever means "newer than it".
   */
  async hydrate(): Promise<void> {
    for (const { facts, events } of await this.loadLogs()) this.retain(facts, events);
    this.emit();
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
  private async loadLogs(): Promise<RunLogEntry[]> {
    if (this.store.listRunLogs) return this.store.listRunLogs();
    const { runs } = await this.store.listRuns();
    return Promise.all(
      runs.map(async (run) => ({ facts: factsOf(run), events: await this.store.eventsSince(run.id, 0) })),
    );
  }

  /**
   * Take a freshly-read log. The single seam every full replay goes through, so the derived facts a
   * sealed run keeps — its session id, its last seq, its final projection — are computed in exactly
   * one place rather than at each of the four call sites that read a whole log.
   */
  private retain(facts: StoredRunFacts, events: RunEvent[]): void {
    const sessionId = events.find((e) => e.type === 'run.created')?.payload.sessionId;
    this.logs.set(facts.id, {
      facts,
      events,
      lastSeq: events.at(-1)?.seq ?? 0,
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
    });
    this.projected.delete(facts.id);
    if (events.some((e) => TERMINAL_EVENT_TYPES.has(e.type))) this.seal(facts.id);
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
    if (!log || log.final) return;
    const run = this.snapshot(runId);
    if (!run || !isTerminal(run.status)) return;
    log.events = [];
    log.final = run;
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
    if (event.seq > log.lastSeq + 1 || log.final) { void this.adopt(runId, { replace: true }); return; }
    log.events.push(event);
    log.lastSeq = event.seq;
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
    if (log?.final) { await this.adopt(runId, { replace: true }); return; }
    this.applyEvent(runId, event);
  }

  /**
   * Replay one run into the projection. The in-flight map and the post-await `has` check together keep a
   * burst of events for the same unknown run to a single replay, and keep it from racing `createRun`,
   * which registers the same id by a shorter path (the store notifies before its RPC resolves).
   */
  private adopt(runId: string, opts: { replace?: boolean } = {}): Promise<void> {
    const inFlight = this.adopting.get(runId);
    if (inFlight) return inFlight;
    if (this.logs.has(runId) && !opts.replace) return Promise.resolve();
    const started = this.replay(runId, opts);
    const tracked: Promise<void> = started.finally(() => {
      if (this.adopting.get(runId) === tracked) this.adopting.delete(runId);
    });
    this.adopting.set(runId, tracked);
    return tracked;
  }

  private async replay(runId: string, opts: { replace?: boolean }): Promise<void> {
    try {
      const run = await this.store.getRun(runId);
      if (!run || (this.logs.has(runId) && !opts.replace)) return;
      const events = await this.store.eventsSince(runId, 0);
      if (this.logs.has(runId) && !opts.replace) return;
      this.retain(factsOf(run), events);
      this.emit();
    } catch {
      // The store is unreachable; the run is not lost, only unseen. A later event retries.
    }
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const run = await this.store.createRun(input);
    const events = await this.store.eventsSince(run.id, 0);
    this.retain(factsOf(run), events);
    this.emit();
    return run;
  }

  /**
   * How many raw envelopes this projection is holding for a run. Zero once the run is terminal — the
   * retention bound is a property callers and tests can actually check, not a comment.
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
   * The run a still-pending decision belongs to, replayed rather than remembered. An answer arrives
   * carrying only the card's id, and a map from card to run would be one more thing to keep in step
   * with the log — the log already knows, because a resolved decision is no longer pending.
   */
  runForDecision(decisionId: string): string | undefined {
    for (const runId of this.logs.keys()) {
      if (this.snapshot(runId)!.pendingDecisions.some((d) => d.decisionId === decisionId)) return runId;
    }
    return undefined;
  }

  /**
   * Law 4's enforcement seam. Attaching a tab another run owns is refused outright; re-attaching to the
   * owner is a no-op rather than a duplicate fact.
   */
  async attachTab(runId: string, tabId: string, url?: string): Promise<void> {
    const owner = this.ownerOf(tabId);
    if (owner === runId) return;
    if (owner !== undefined) throw new TabOwnedError(tabId, owner);
    const event = await this.store.appendEvent(runId, {
      actor: { kind: 'agent', driver: 'studio' },
      type: 'tab.attached',
      payload: { tabId, ...(url ? { url } : {}) },
    });
    await this.fold(runId, event);
  }

  /** A tab nobody owns is the human's, and closing it is not a run fact. */
  async detachTab(tabId: string, reason: TabDetachReason): Promise<void> {
    const runId = this.ownerOf(tabId);
    if (runId === undefined) return;
    const event = await this.store.appendEvent(runId, {
      actor: { kind: 'agent', driver: 'studio' },
      type: 'tab.detached',
      payload: { tabId, reason },
    });
    await this.fold(runId, event);
  }

  /** Terminal transition: release the run's tabs first, so the log never ends owning a dead tab. */
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

  ownerOf(tabId: string): string | undefined {
    for (const runId of this.logs.keys()) if (this.snapshot(runId)!.tabIds.includes(tabId)) return runId;
    return undefined;
  }

  isUserTab(tabId: string): boolean {
    return this.ownerOf(tabId) === undefined;
  }

  tabsOf(runId: string): string[] {
    return this.snapshot(runId)?.tabIds ?? [];
  }

  /**
   * The agent-visible tab enumeration. Built from what the run owns and then narrowed to what still
   * exists — never from the tab universe filtered down, so a tab the human opened has no path into it.
   */
  agentVisibleTabs(runId: string, universe?: readonly string[]): string[] {
    const owned = this.tabsOf(runId);
    return universe ? owned.filter((t) => universe.includes(t)) : owned;
  }

  /** The human's own group: everything in the universe that no run has ever attached. */
  userTabs(universe: readonly string[]): string[] {
    return universe.filter((t) => this.isUserTab(t));
  }

  list(): RunSummary[] {
    return [...this.logs.keys()].map((id) => {
      const run = this.snapshot(id)!;
      return { id: run.id, task: run.task, status: run.status, tabIds: run.tabIds, visibility: run.visibility };
    });
  }

  snapshot(runId: string): Run | undefined {
    const log = this.logs.get(runId);
    if (!log) return undefined;
    if (log.final) return log.final;
    let run = this.projected.get(runId);
    if (!run) {
      run = projectRun(log.facts, log.events);
      this.projected.set(runId, run);
    }
    return run;
  }
}
