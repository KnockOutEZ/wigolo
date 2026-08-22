import { RUN_ID_ALPHABET, type CreateRunInput, type ListRunsResult, type Run, type RunEvent, type RunEventInput } from 'wigolo/studio';
import type { RunLogEntry, RunStoreClient } from '../../src/main/run-view-model';

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

  async getRun(runId: string): Promise<Run | undefined> {
    this.reads.push('getRun');
    const f = this.facts.get(runId);
    if (!f) return undefined;
    const events = this.log.get(runId)!;
    return {
      id: runId, task: f.task, spaceId: f.spaceId, createdAt: f.createdAt,
      status: 'running', driver: { kind: 'studio' },
      tabIds: [], pendingDecisions: [], cost: { browserActions: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0 },
      visibility: 'hidden', lastSeq: events.length, updatedAt: f.createdAt,
    };
  }

  async listRuns(): Promise<ListRunsResult> {
    this.reads.push('listRuns');
    const runs = await Promise.all([...this.facts.keys()].map((id) => this.getRun(id)));
    return { runs: runs.filter((r): r is Run => r !== undefined) };
  }

  /**
   * The combined boot read, as the broker serves it: facts and events together, one round-trip for the
   * page. Deliberately does NOT project — that is what makes it cheaper than `listRuns` + a read per run.
   */
  async listRunLogs(): Promise<RunLogEntry[]> {
    this.reads.push('listRunLogs');
    return [...this.facts.entries()].map(([id, f]) => ({
      facts: { id, task: f.task, spaceId: f.spaceId, createdAt: f.createdAt },
      events: [...(this.log.get(id) ?? [])],
    }));
  }

  async eventsSince(runId: string, since = 0, limit?: number): Promise<RunEvent[]> {
    this.reads.push('eventsSince');
    const page = (this.log.get(runId) ?? []).filter((e) => e.seq > since);
    return limit === undefined ? page : page.slice(0, limit);
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
