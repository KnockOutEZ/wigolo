import { projectRun, type CreateRunInput, type ListRunsResult, type Run, type RunEvent, type RunEventInput, type StoredRunFacts } from 'wigolo/studio';
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

/** The store, as this process reaches it. Broker-backed in the app; the port exists so tests can bind. */
export interface RunStoreClient {
  createRun(input: CreateRunInput): Promise<Run>;
  appendEvent(runId: string, event: RunEventInput): Promise<RunEvent>;
  getRun(runId: string): Promise<Run | undefined>;
  listRuns(): Promise<ListRunsResult>;
  eventsSince(runId: string, since?: number): Promise<RunEvent[]>;
  onRunEvent(handler: (runId: string, event: RunEvent) => void): void;
}

export function createBrokerRunStoreClient(broker: BrokerClient): RunStoreClient {
  return {
    createRun: (input) => broker.call<Run>('runCreate', { input }),
    appendEvent: (runId, event) => broker.call<RunEvent>('runAppend', { runId, event }),
    getRun: (runId) => broker.call<Run | undefined>('runGet', { runId }),
    listRuns: () => broker.call<ListRunsResult>('runList', {}),
    eventsSince: (runId, since = 0) => broker.call<RunEvent[]>('runEventsSince', { runId, since }),
    onRunEvent: (handler) => broker.onRunEvent(handler),
  };
}

export class TabOwnedError extends Error {
  constructor(readonly tabId: string, readonly ownerRunId: string) {
    super(`tab ${tabId} already belongs to run ${ownerRunId}`);
    this.name = 'TabOwnedError';
  }
}

export type TabDetachReason = 'closed' | 'run_ended';
export type RunTerminal = 'completed' | 'failed' | 'cancelled';

/** What a surface needs to name a run. Everything on it is projected; nothing is stored here. */
export interface RunSummary {
  id: string;
  task: string;
  status: Run['status'];
  tabIds: string[];
}

interface RunLog {
  facts: StoredRunFacts;
  events: RunEvent[];
}

export class RunViewModel {
  /** A verbatim replica of the log, refillable at any time from the store. Not a second source of truth. */
  private readonly logs = new Map<string, RunLog>();
  /** Memoised `projectRun` output, dropped whenever a run's events change. A pure function's cache. */
  private readonly projected = new Map<string, Run>();
  private readonly listeners = new Set<() => void>();
  /** Runs being replayed right now, so a burst of events for one of them causes a single replay. */
  private readonly adopting = new Set<string>();

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

  /** Replay every run from the store. Safe to call repeatedly — it discards what it holds first. */
  async hydrate(): Promise<void> {
    const { runs } = await this.store.listRuns();
    this.logs.clear();
    this.projected.clear();
    for (const run of runs) {
      const events = await this.store.eventsSince(run.id, 0);
      this.logs.set(run.id, { facts: { id: run.id, task: run.task, spaceId: run.spaceId, createdAt: run.createdAt }, events });
    }
    this.emit();
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
    const last = log.events.at(-1)?.seq ?? 0;
    if (event.seq <= last) return;
    // A gap means an envelope was missed — one that landed while this run was being adopted, or a
    // dropped notify. Appending the newer one anyway would leave a log that silently disagrees with the
    // store, so the run is replayed from scratch instead. Same contract as #46's SSE tail.
    if (event.seq > last + 1) { void this.adopt(runId, { replace: true }); return; }
    log.events.push(event);
    this.projected.delete(runId);
    this.emit();
  }

  /**
   * Replay one run into the projection. `in flight` and the post-await `has` check together keep a burst
   * of events for the same unknown run to a single replay, and keep it from racing `createRun`, which
   * registers the same id by a shorter path (the store notifies before its RPC resolves).
   */
  private async adopt(runId: string, opts: { replace?: boolean } = {}): Promise<void> {
    if ((this.logs.has(runId) && !opts.replace) || this.adopting.has(runId)) return;
    this.adopting.add(runId);
    try {
      const run = await this.store.getRun(runId);
      if (!run || (this.logs.has(runId) && !opts.replace)) return;
      const events = await this.store.eventsSince(runId, 0);
      if (this.logs.has(runId) && !opts.replace) return;
      this.logs.set(runId, { facts: { id: run.id, task: run.task, spaceId: run.spaceId, createdAt: run.createdAt }, events });
      this.projected.delete(runId);
      this.emit();
    } catch {
      // The store is unreachable; the run is not lost, only unseen. A later event retries.
    } finally {
      this.adopting.delete(runId);
    }
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const run = await this.store.createRun(input);
    const events = await this.store.eventsSince(run.id, 0);
    this.logs.set(run.id, { facts: { id: run.id, task: run.task, spaceId: run.spaceId, createdAt: run.createdAt }, events });
    this.projected.delete(run.id);
    this.emit();
    return run;
  }

  /**
   * The daemon studio session that spawned this run (§7.3's linkage), replayed from `run.created`.
   * A session is how a client connects; a run is the task — so the link is a recorded fact, not a
   * second map for the host to keep in step with the log.
   */
  sessionIdOf(runId: string): string | undefined {
    const created = this.logs.get(runId)?.events.find((e) => e.type === 'run.created');
    const sessionId = created?.payload.sessionId;
    return typeof sessionId === 'string' ? sessionId : undefined;
  }

  runForSession(sessionId: string): string | undefined {
    for (const runId of this.logs.keys()) if (this.sessionIdOf(runId) === sessionId) return runId;
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
    this.applyEvent(runId, event);
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
    this.applyEvent(runId, event);
  }

  /** Terminal transition: release the run's tabs first, so the log never ends owning a dead tab. */
  async endRun(runId: string, terminal: RunTerminal, detail?: string): Promise<void> {
    for (const tabId of this.tabsOf(runId)) await this.detachTab(tabId, 'run_ended');
    const payload: Record<string, unknown> =
      terminal === 'failed' ? { error: detail ?? 'the run ended unexpectedly' }
        : terminal === 'cancelled' ? { by: 'system' }
          : { ...(detail ? { outcome: detail } : {}) };
    const event = await this.store.appendEvent(runId, { actor: { kind: 'system' }, type: `run.${terminal}`, payload });
    this.applyEvent(runId, event);
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
      return { id: run.id, task: run.task, status: run.status, tabIds: run.tabIds };
    });
  }

  snapshot(runId: string): Run | undefined {
    const log = this.logs.get(runId);
    if (!log) return undefined;
    let run = this.projected.get(runId);
    if (!run) {
      run = projectRun(log.facts, log.events);
      this.projected.set(runId, run);
    }
    return run;
  }
}
