/**
 * Per-session observability gauges. Token-spend is attributable to a single session
 * (the host owns one SessionMetrics per session); memory is a PROCESS-level reading
 * (process.memoryUsage) — a shared process has no honest per-session attribution, so
 * it is reported as a process gauge, not claimed per session. `read()` is a pure
 * snapshot: reading the gauge MUST NOT mutate session state or the counters themselves.
 */
export interface SessionMetricsReport {
  /** Cumulative tokens emitted by this session's page-perception payloads. */
  tokensSpent: number;
  /** PROCESS resident set size in bytes — NOT per-session (shared process). */
  processMemoryRssBytes: number;
  /** PROCESS heap-used in bytes — NOT per-session. */
  processHeapUsedBytes: number;
}

export type MemorySource = () => NodeJS.MemoryUsage;

export class SessionMetrics {
  private _tokensSpent = 0;

  /** Attribute token output to the session (no-op on non-positive counts). */
  recordTokens(n: number): void {
    if (n > 0) this._tokensSpent += n;
  }

  /**
   * A pure read of the current gauges plus a fresh process-memory sample. Does not
   * mutate any counter — call it as often as you like without perturbing the source.
   */
  read(memSource: MemorySource = process.memoryUsage): SessionMetricsReport {
    const mem = memSource();
    return {
      tokensSpent: this._tokensSpent,
      processMemoryRssBytes: mem.rss,
      processHeapUsedBytes: mem.heapUsed,
    };
  }
}
