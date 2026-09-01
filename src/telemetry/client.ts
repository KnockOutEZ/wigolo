/**
 * The telemetry client: queue, batch, flush, back off, and never get in the way.
 *
 * Invariants this file exists to hold:
 *  - Off means NO queue writes and NO network. Not "writes that are never sent" — nothing
 *    reaches disk either, so an install with telemetry off leaves no telemetry footprint.
 *  - Never blocks a host operation. `emit` is synchronous and append-only; a flush it
 *    triggers is fire-and-forget, and a CLI one-shot exits without waiting for one.
 *  - Never surfaces an error. Only two things drop data, both silently: cap eviction in the
 *    queue, and a terminal send failure here (a 4xx the server will reject identically
 *    forever, or a single event too large to fit a batch alone).
 *  - Never exceeds the account's 120-batches/hour limit. The 60 s minimum spacing caps
 *    flushes at 60/h by construction, so the ≥50-event trigger cannot outrun it.
 */
import { AccountsClient } from '../account/client.js';
import { maybeRefresh } from '../account/refresh.js';
import { AccountStateStore } from '../account/state.js';
import { getAccessToken } from '../account/token-store.js';
import { createLogger } from '../logger.js';
import { buildEnvelope, chunkEvents, clientInfo, type TelemetryClientInfo } from './envelope.js';
import type { TelemetryEvent } from './events.js';
import { isValidEvent } from './events.js';
import { TelemetryQueue, type QueuedEvent } from './queue.js';

const log = createLogger('telemetry');

/** Flush once this many events are queued. */
export const FLUSH_EVENT_THRESHOLD = 50;

/** Long-lived surfaces also flush on this timer. */
export const FLUSH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Minimum wall-clock gap between two flush ATTEMPTS.
 *
 * This is the whole reason the 50-event trigger is safe: at one attempt per 60 s the client
 * cannot exceed 60 batches/hour, half of PX1's 120/hour account limit, no matter how fast
 * events arrive. The limit is respected by construction rather than by counting.
 */
export const MIN_FLUSH_SPACING_MS = 60 * 1000;

/** Used when a 429 arrives without a `retry_after_s`. */
export const DEFAULT_RETRY_AFTER_S = 60;

/** How long an activation check is trusted before the state file is re-read. */
export const ACTIVATION_TTL_MS = 60 * 1000;

export type FlushStatus =
  | 'disabled'
  | 'not_activated'
  | 'spaced'
  | 'backoff'
  | 'empty'
  | 'no_token'
  | 'sent'
  | 'retained';

export interface FlushResult {
  status: FlushStatus;
  /** Events the server accepted. */
  sent: number;
  /** Events dropped terminally — see the file docstring for the only two ways that happens. */
  dropped: number;
  /** Events still on disk after the attempt. */
  retained: number;
}

export interface TelemetryClientOpts {
  dataDir: string;
  accountsUrl: string;
  /** Resolved switch — env > persisted > default-on. See `./off-switch.ts`. */
  enabled: boolean;
  /** Injected in tests and by the daemon's pooled agent, exactly as the accounts client does. */
  accountsClient?: AccountsClient;
  /** Injected clock; every time decision in this class reads it. */
  now?: () => number;
  /** Injected so a test can assert client info without reading the real package version. */
  client?: TelemetryClientInfo;
}

type Halt = { reason: 'retry_after'; seconds: number } | { reason: 'transient' };

interface SendOutcome {
  accepted: QueuedEvent[];
  dropped: QueuedEvent[];
  halt: Halt | null;
}

export class TelemetryClient {
  private readonly queue: TelemetryQueue;
  private readonly accounts: AccountsClient;
  private readonly state: AccountStateStore;
  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly clientInfoValue: TelemetryClientInfo;

  readonly enabled: boolean;

  private queuedSinceFlush = 0;
  private lastFlushAtMs = 0;
  private retryNotBeforeMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<FlushResult> | null = null;
  private activated: boolean | null = null;
  private activationCheckedAtMs = 0;

  constructor(opts: TelemetryClientOpts) {
    this.dataDir = opts.dataDir;
    this.enabled = opts.enabled;
    this.now = opts.now ?? (() => Date.now());
    this.queue = new TelemetryQueue(opts.dataDir);
    this.accounts = opts.accountsClient ?? new AccountsClient({ baseUrl: opts.accountsUrl });
    this.state = new AccountStateStore(opts.dataDir);
    this.clientInfoValue = opts.client ?? clientInfo();
  }

  /**
   * Is this install activated?
   *
   * Telemetry stays entirely off until it is: there is no account to key a batch to, and
   * the activation gate refuses tool calls anyway, so an un-activated install has nothing
   * truthful to report. Cached for {@link ACTIVATION_TTL_MS} because `emit` is on tool-call
   * paths and a state-file read per event is not free.
   */
  isActivated(): boolean {
    const nowMs = this.now();
    if (this.activated !== null && nowMs - this.activationCheckedAtMs < ACTIVATION_TTL_MS) {
      return this.activated;
    }
    this.activated = this.state.read().account_id !== null;
    this.activationCheckedAtMs = nowMs;
    return this.activated;
  }

  /** True when this client may write to disk and talk to the network at all. */
  isCollecting(): boolean {
    return this.enabled && this.isActivated();
  }

  /**
   * Queue one event.
   *
   * Synchronous and total: it never throws, never awaits, and returns whether the event was
   * actually queued so a test can assert the off path wrote nothing.
   */
  emit(event: TelemetryEvent): boolean {
    if (!this.isCollecting()) return false;
    if (!isValidEvent(event)) {
      // Unreachable from typed first-party code; reachable through an `unknown` boundary.
      log.debug('telemetry event rejected by the closed dictionary', { name: (event as { name?: unknown }).name });
      return false;
    }
    const queued: QueuedEvent = { ...event, ts: new Date(this.now()).toISOString() };
    this.queue.append(queued);
    this.queuedSinceFlush += 1;
    if (this.timer !== null && this.queuedSinceFlush >= FLUSH_EVENT_THRESHOLD) {
      // Fire-and-forget. A one-shot process has no timer, so it appends and exits.
      void this.flush();
    }
    return true;
  }

  /**
   * Arm the 15-minute timer. Long-lived surfaces only — the timer is unref'd so it can never
   * be the reason a process stays alive.
   */
  start(): void {
    if (this.timer !== null || !this.isCollecting()) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Drain the queue to the service.
   *
   * Concurrent callers share one attempt: the timer and the ≥50 trigger can fire together,
   * and two overlapping drains would double-send the same rows.
   */
  async flush(): Promise<FlushResult> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.runFlush();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runFlush(): Promise<FlushResult> {
    const idle = (status: FlushStatus): FlushResult => ({ status, sent: 0, dropped: 0, retained: this.queuedSinceFlush });
    if (!this.enabled) return idle('disabled');
    if (!this.isActivated()) return idle('not_activated');

    const nowMs = this.now();
    if (nowMs < this.retryNotBeforeMs) return idle('backoff');
    if (this.lastFlushAtMs !== 0 && nowMs - this.lastFlushAtMs < MIN_FLUSH_SPACING_MS) return idle('spaced');

    // Stamped BEFORE the attempt: a flush that hangs or fails must still consume its slot,
    // or a failing service would be retried on every subsequent event.
    this.lastFlushAtMs = nowMs;
    this.queue.cleanLegacyDayFiles();

    const events = this.queue.readAll();
    this.queuedSinceFlush = events.length;
    if (events.length === 0) return idle('empty');

    const token = await this.acquireAccessToken();
    if (token === null) return { status: 'no_token', sent: 0, dropped: 0, retained: events.length };

    const settled = new Set<QueuedEvent>();
    let sent = 0;
    let dropped = 0;
    let halted = false;

    for (const chunk of chunkEvents(events, this.clientInfoValue)) {
      const outcome = await this.sendChunk(chunk, token);
      for (const e of outcome.accepted) settled.add(e);
      for (const e of outcome.dropped) settled.add(e);
      sent += outcome.accepted.length;
      dropped += outcome.dropped.length;
      if (outcome.halt !== null) {
        if (outcome.halt.reason === 'retry_after') {
          this.retryNotBeforeMs = this.now() + outcome.halt.seconds * 1000;
        }
        halted = true;
        break;
      }
    }

    const remaining = events.filter((e) => !settled.has(e));
    this.queue.replace(remaining);
    this.queuedSinceFlush = remaining.length;
    if (dropped > 0) log.debug('telemetry events dropped terminally', { dropped });
    return { status: halted ? 'retained' : 'sent', sent, dropped, retained: remaining.length };
  }

  /**
   * A Bearer access token, minted through the refresh policy when the cached one is stale.
   *
   * A `null` here is not a failure to report: the refresh throttle deliberately allows one
   * attempt per install per day, so a short-lived process usually finds no cached token and
   * gets `throttled`. The events stay queued for whichever surface next holds a token.
   */
  private async acquireAccessToken(): Promise<string | null> {
    const cached = getAccessToken({ dataDir: this.dataDir }, this.now());
    if (cached !== null) return cached;
    const outcome = await maybeRefresh({ dataDir: this.dataDir, client: this.accounts, nowMs: this.now });
    if (outcome.status !== 'refreshed') {
      log.debug('telemetry flush has no access token', { refresh: outcome.status });
      return null;
    }
    return getAccessToken({ dataDir: this.dataDir }, this.now());
  }

  /**
   * Send one chunk, bisecting on 413.
   *
   * The proactive chunking in `envelope.ts` already respects both server caps, so a 413 here
   * means the per-field caps composed past the body limit in a way byte-counting missed.
   * Bisecting isolates the offending event instead of condemning the batch; a single event
   * that still will not fit is the terminal case and is dropped alone.
   */
  private async sendChunk(chunk: QueuedEvent[], token: string): Promise<SendOutcome> {
    const result = await this.accounts.telemetryBatch(token, buildEnvelope(chunk, this.clientInfoValue));
    if (result.ok) return { accepted: chunk, dropped: [], halt: null };

    if (result.status === 429) {
      // Events stay queued; the next attempt waits out the server's own window.
      return { accepted: [], dropped: [], halt: { reason: 'retry_after', seconds: result.retryAfterS ?? DEFAULT_RETRY_AFTER_S } };
    }

    if (result.status === 413) {
      if (chunk.length === 1) return { accepted: [], dropped: chunk, halt: null };
      const mid = Math.ceil(chunk.length / 2);
      const first = await this.sendChunk(chunk.slice(0, mid), token);
      if (first.halt !== null) return first;
      const second = await this.sendChunk(chunk.slice(mid), token);
      return {
        accepted: [...first.accepted, ...second.accepted],
        dropped: [...first.dropped, ...second.dropped],
        halt: second.halt,
      };
    }

    if (result.status === 400) {
      // `invalid_event` or `batch_too_large`: a shape the server will reject identically
      // forever. Retaining it would wedge the queue behind data that can never leave.
      return { accepted: [], dropped: chunk, halt: null };
    }

    // 401/403 (token about to be re-minted), 5xx, network, timeout, malformed — all
    // retryable. Stop the drain and keep everything.
    return { accepted: [], dropped: [], halt: { reason: 'transient' } };
  }

  /** Test seam: the queue this client owns. */
  get queueForTest(): TelemetryQueue {
    return this.queue;
  }
}
