import {
  RUN_ID_ALPHABET,
  projectRun,
  type CreateRunInput,
  type ListRunsOptions,
  type ListRunsResult,
  type Run,
  type RunEvent,
  type RunEventInput,
  type StoredRunFacts,
} from 'wigolo/studio';
import type { RunLogPage, RunStoreClient } from '../../src/main/run-view-model';

/**
 * A faithful in-memory stand-in for the daemon run store: it assigns `seq` and `ts` (callers never
 * can), it is append-only, and it fans committed envelopes out to the live-tail handlers the way the
 * broker's `run-event` notify does — before the call that caused them resolves, as the broker's own
 * ordering does. The app never loads the native DB, so the real store cannot bind in these tests, but
 * every rule the view-model depends on is reproduced here.
 *
 * Two of those rules are easy to fake WRONG, and both were:
 *  - ids come from the mint alphabet. `run1` is not a run id the real store could ever produce, and
 *    a surface that path-joins or validates one rejects it — so a fixture that mints them tests a
 *    world where every id is legal.
 *  - the clock runs now. Timestamps frozen in the past make every pending decision arrive already
 *    past its two-minute auto-deny, which is a state the real store can only reach after a crash.
 */
const FAKE_EPOCH = Date.now();

/** Deterministic, monotonic, and inside the mint alphabet — the three things a real id is. */
function fakeRunId(n: number): string {
  const a = RUN_ID_ALPHABET;
  return 'r' + a[n % a.length] + a[Math.floor(n / a.length) % a.length] + a[Math.floor(n / (a.length * a.length)) % a.length];
}

export class FakeRunStore implements RunStoreClient {
  readonly facts = new Map<string, { task: string; spaceId: string; createdAt: string }>();
  readonly log = new Map<string, RunEvent[]>();
  private handlers: Array<(runId: string, e: RunEvent) => void> = [];
  private n = 0;
  /** Every append that reached the store, so a test can assert what was NOT written. */
  readonly appends: Array<{ runId: string; type: string; payload: Record<string, unknown> }> = [];
  /**
   * Every read that reached the store, in order. The broker is one stdio pipe, so a read here is a
   * round-trip there — which makes this the instrument for "how much does boot cost", a claim no
   * assertion about the resulting projection can see.
   */
  readonly reads: string[] = [];
  /**
   * Every log read, with the seq it started from. `reads` says a read happened; only the `since` says
   * whether it was a tail or a re-materialization of the whole run — which is the difference between
   * folding a live long run and paying for it again from envelope zero.
   */
  readonly eventReads: Array<{ runId: string; since: number; limit: number | undefined }> = [];
  /**
   * The store's own bounds, mirrored so a test can FORCE them instead of building a log big enough
   * to trip the shipped ones. The broker's real numbers are two and four orders of magnitude larger;
   * what a test has to exercise is the behaviour at the boundary, which is identical either side of
   * it. Defaults are effectively no cap, so every arm that is not about the bound is unaffected.
   */
  bootEventCapPerRun = Number.POSITIVE_INFINITY;
  /**
   * The boot page's allowance across the whole CALL, spent run by run — the broker's
   * `MAX_BOOT_EVENTS_TOTAL`. It is a local of each call there, and reproducing that is the point:
   * the defect the host-side allowance exists for is that this resets on every page, so a fake that
   * had no per-call total could not show the multiplication it removes.
   */
  bootEventCapTotal = Number.POSITIVE_INFINITY;
  listLimit = Number.POSITIVE_INFINITY;
  /** The server-side per-frame ceiling: a caller asking for more than this gets a SHORT page. */
  eventsPageCeiling = Number.POSITIVE_INFINITY;

  async createRun(input: CreateRunInput): Promise<Run> {
    const id = fakeRunId(++this.n);
    const createdAt = new Date(FAKE_EPOCH + this.n).toISOString();
    this.facts.set(id, { task: input.task, spaceId: input.spaceId ?? 'default', createdAt });
    this.log.set(id, []);
    this.commit(id, {
      actor: { kind: 'daemon' },
      type: 'run.created',
      payload: {
        task: input.task,
        spaceId: input.spaceId ?? 'default',
        driver: input.driver ?? { kind: 'studio' },
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
    });
    return (await this.getRun(id))!;
  }

  async appendEvent(runId: string, event: RunEventInput): Promise<RunEvent> {
    if (!this.log.has(runId)) throw new Error(`unknown run: ${runId}`);
    this.appends.push({ runId, type: event.type, payload: event.payload ?? {} });
    return this.commit(runId, event);
  }

  private commit(runId: string, event: RunEventInput): RunEvent {
    const events = this.log.get(runId)!;
    const committed: RunEvent = {
      seq: events.length + 1,
      ts: new Date(FAKE_EPOCH + events.length).toISOString(),
      actor: event.actor,
      type: event.type,
      payload: event.payload ?? {},
    };
    events.push(committed);
    for (const h of this.handlers) h(runId, committed);
    return committed;
  }

  private factsOf(runId: string): StoredRunFacts | undefined {
    const f = this.facts.get(runId);
    return f ? { id: runId, task: f.task, spaceId: f.spaceId, createdAt: f.createdAt } : undefined;
  }

  /**
   * A REAL projection, the way the store's own read is one. It used to answer a hard-coded `running`
   * with no tabs, which is fine while nobody keeps the answer — and the boot read now hands this
   * projection over IN PLACE of a log it cannot send, so a fake one would have made the arm that
   * pins "condensing changes no answer" pass against a projection that was never right.
   */
  async getRun(runId: string): Promise<Run | undefined> {
    this.reads.push('getRun');
    return this.project(runId);
  }

  private project(runId: string): Run | undefined {
    const facts = this.factsOf(runId);
    if (!facts) return undefined;
    const events = this.log.get(runId)!;
    return { ...projectRun(facts, events), lastSeq: events.at(-1)?.seq ?? 0 };
  }

  /** Facts alone — never touches the log, which is the whole claim this read makes. */
  async runFacts(runId: string): Promise<StoredRunFacts | undefined> {
    this.reads.push('runFacts');
    return this.factsOf(runId);
  }

  async listRuns(opts: ListRunsOptions = {}): Promise<ListRunsResult> {
    this.reads.push('listRuns');
    return this.page(opts);
  }

  /** Keyset paging over the id order, which is insertion order here — enough to exercise a cursor. */
  private page(opts: ListRunsOptions): ListRunsResult {
    const ids = [...this.facts.keys()];
    const start = opts.cursor ? ids.indexOf(opts.cursor) + 1 : 0;
    const limit = Math.min(opts.limit ?? this.listLimit, this.listLimit);
    const slice = ids.slice(start, start + limit);
    const runs = slice.map((id) => this.project(id)!).filter((r): r is Run => r !== undefined);
    const last = slice[slice.length - 1];
    return start + slice.length < ids.length && last ? { runs, nextCursor: last } : { runs };
  }

  /**
   * The combined boot read, as the broker serves it: facts and events together, one round-trip for the
   * page. Deliberately does NOT project the runs it can send whole — that is what makes it cheaper
   * than `listRuns` + a read per run.
   *
   * A run whose log is over the cap is answered with its projection instead of its envelopes, and
   * always with the store's TRUE tail seq, exactly as the broker does.
   */
  async listRunLogs(opts: ListRunsOptions = {}): Promise<RunLogPage> {
    this.reads.push('listRunLogs');
    const { runs, nextCursor } = this.page(opts);
    let eventsLeft = this.bootEventCapTotal;
    const entries = runs.map((run) => {
      const events = this.log.get(run.id) ?? [];
      const lastSeq = events.at(-1)?.seq ?? 0;
      const facts = this.factsOf(run.id)!;
      if (events.length <= Math.min(this.bootEventCapPerRun, eventsLeft)) {
        eventsLeft -= events.length;
        return { facts, events: [...events], lastSeq };
      }
      const sessionId = events[0]?.payload.sessionId;
      return {
        facts,
        events: [],
        lastSeq,
        projection: run,
        ...(typeof sessionId === 'string' ? { sessionId } : {}),
      };
    });
    return { entries, ...(nextCursor ? { nextCursor } : {}) };
  }

  async eventsSince(runId: string, since = 0, limit?: number): Promise<RunEvent[]> {
    this.reads.push('eventsSince');
    this.eventReads.push({ runId, since, limit });
    const page = (this.log.get(runId) ?? []).filter((e) => e.seq > since);
    return page.slice(0, Math.min(limit ?? this.eventsPageCeiling, this.eventsPageCeiling));
  }

  /** A key probe: it never touches the log, which is the whole claim `exists` makes. */
  async runExists(runId: string): Promise<boolean> {
    this.reads.push('runExists');
    return this.facts.has(runId);
  }

  onRunEvent(handler: (runId: string, event: RunEvent) => void): void {
    this.handlers.push(handler);
  }
}
