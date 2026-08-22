import type { CreateRunInput, ListRunsResult, Run, RunEvent, RunEventInput } from 'wigolo/studio';
import type { RunStoreClient } from '../../src/main/run-view-model';

/**
 * A faithful in-memory stand-in for the daemon run store: it assigns `seq` and `ts` (callers never
 * can), it is append-only, and it fans committed envelopes out to the live-tail handlers the way the
 * broker's `run-event` notify does — before the call that caused them resolves, as the broker's own
 * ordering does. The app never loads the native DB, so the real store cannot bind in these tests, but
 * every rule the view-model depends on is reproduced here.
 */
export class FakeRunStore implements RunStoreClient {
  readonly facts = new Map<string, { task: string; spaceId: string; createdAt: string }>();
  readonly log = new Map<string, RunEvent[]>();
  private handlers: Array<(runId: string, e: RunEvent) => void> = [];
  private n = 0;
  /** Every append that reached the store, so a test can assert what was NOT written. */
  readonly appends: Array<{ runId: string; type: string; payload: Record<string, unknown> }> = [];

  async createRun(input: CreateRunInput): Promise<Run> {
    const id = `run${++this.n}`;
    const createdAt = new Date(1_700_000_000_000 + this.n).toISOString();
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
      ts: new Date(1_700_000_000_000 + events.length).toISOString(),
      actor: event.actor,
      type: event.type,
      payload: event.payload ?? {},
    };
    events.push(committed);
    for (const h of this.handlers) h(runId, committed);
    return committed;
  }

  async getRun(runId: string): Promise<Run | undefined> {
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
    const runs = await Promise.all([...this.facts.keys()].map((id) => this.getRun(id)));
    return { runs: runs.filter((r): r is Run => r !== undefined) };
  }

  async eventsSince(runId: string, since = 0): Promise<RunEvent[]> {
    return (this.log.get(runId) ?? []).filter((e) => e.seq > since);
  }

  onRunEvent(handler: (runId: string, event: RunEvent) => void): void {
    this.handlers.push(handler);
  }
}
