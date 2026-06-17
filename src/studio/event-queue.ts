/**
 * Per-session queue of human events (navigations now; marks/comments in Phase 3) that
 * `studio_observe` drains for the agent. Delivery is EXACTLY-ONCE via a cursor-ack,
 * the same discipline 2F's base-id gave the diff:
 *
 *  - `drainSince(cursor)` returns events newer than the consumer's last-acked cursor
 *    and trims the acked ones — but it does NOT remove the newer events until the
 *    cursor advances. So if the observe response is lost crossing the stdio↔host
 *    proxy, the next drain at the same cursor REPLAYS them (no silent loss).
 *  - Bounded: on overflow the oldest events drop and the `dropped` count is surfaced
 *    (fail-loud), so the consumer can force a full resync rather than silently
 *    proceed on a gappy event stream. The dropped signal is itself cursor-ack-DURABLE
 *    the same way: it clears only once the consumer's cursor advances PAST the drop's
 *    high-water seq — so a lost drain response (re-drain at the same cursor) REPLAYS
 *    "you dropped events, resync" instead of swallowing it.
 */

export interface StudioEvent {
  type: string;
  [key: string]: unknown;
}

export interface DrainedEvents {
  events: Array<StudioEvent & { seq: number }>;
  /** High-water seq; the consumer passes this back as `since` next turn (its ack). */
  cursor: number;
  /** Events lost to overflow since the previous drain — non-zero means "resync, your stream has a gap". */
  dropped: number;
}

export class StudioEventQueue {
  private buffer: Array<StudioEvent & { seq: number }> = [];
  private seq = 0;
  private dropped = 0;
  /** High-water seq at the most recent drop; the dropped count clears only once `since` passes it (ack). */
  private droppedAtSeq = 0;

  constructor(private readonly cap: number) {}

  enqueue(event: StudioEvent): void {
    this.seq += 1;
    this.buffer.push({ ...event, seq: this.seq });
    while (this.buffer.length > this.cap) {
      this.buffer.shift();
      this.dropped += 1;
      this.droppedAtSeq = this.seq;
    }
  }

  /** Trim events the consumer acked (seq ≤ since), then return everything newer. Does not drop unacked events. */
  drainSince(since: number): DrainedEvents {
    this.buffer = this.buffer.filter((e) => e.seq > since);
    // Clear the dropped signal only once the cursor advances PAST the drop's high-water
    // seq — the same cursor-ack durability the events get. A re-drain at an unchanged
    // cursor (a lost response) therefore REPLAYS dropped rather than swallowing it.
    if (since >= this.droppedAtSeq) this.dropped = 0;
    return { events: [...this.buffer], cursor: this.seq, dropped: this.dropped };
  }

  get pending(): number {
    return this.buffer.length;
  }

  /** High-water seq (latest enqueued). Used to detect an event slipping in during an async snapshot capture. */
  get cursor(): number {
    return this.seq;
  }
}
