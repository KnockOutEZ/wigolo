/**
 * Per-session observability gauges. Token-spend and frame counters are attributable
 * to a single session (the host owns one SessionMetrics per session); memory is a
 * PROCESS-level reading (process.memoryUsage) — a shared process has no honest
 * per-session attribution, so it is reported as a process gauge, not claimed per
 * session. `read()` is a pure snapshot: reading the gauge MUST NOT mutate session
 * state or the counters themselves.
 */
export interface SessionMetricsReport {
  /** Cumulative tokens emitted by this session's page-perception payloads. */
  tokensSpent: number;
  /** Screencast frames forwarded to the client (the numerator of an observed frame rate). */
  framesForwarded: number;
  /** Screencast frames dropped under backpressure (newest-held-wins). */
  framesDropped: number;
  /** PROCESS resident set size in bytes — NOT per-session (shared process). */
  processMemoryRssBytes: number;
  /** PROCESS heap-used in bytes — NOT per-session. */
  processHeapUsedBytes: number;
}

export type MemorySource = () => NodeJS.MemoryUsage;

export class SessionMetrics {
  private _tokensSpent = 0;
  private _framesForwarded = 0;
  private _framesDropped = 0;

  /** Attribute token output to the session (no-op on non-positive counts). */
  recordTokens(n: number): void {
    if (n > 0) this._tokensSpent += n;
  }

  recordFrameForwarded(): void {
    this._framesForwarded += 1;
  }

  recordFrameDropped(): void {
    this._framesDropped += 1;
  }

  /**
   * A pure read of the current gauges plus a fresh process-memory sample. Does not
   * mutate any counter — call it as often as you like without perturbing the source.
   */
  read(memSource: MemorySource = process.memoryUsage): SessionMetricsReport {
    const mem = memSource();
    return {
      tokensSpent: this._tokensSpent,
      framesForwarded: this._framesForwarded,
      framesDropped: this._framesDropped,
      processMemoryRssBytes: mem.rss,
      processHeapUsedBytes: mem.heapUsed,
    };
  }
}
