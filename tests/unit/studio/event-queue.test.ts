import { describe, it, expect } from 'vitest';
import { StudioEventQueue } from '../../../src/studio/event-queue.js';

describe('StudioEventQueue — exactly-once delivery via cursor-ack (CEO trap a)', () => {
  it('drains events after the cursor and reports the new high-water cursor', () => {
    const q = new StudioEventQueue(100);
    q.enqueue({ type: 'navigation', url: 'https://a.example' });
    q.enqueue({ type: 'navigation', url: 'https://b.example' });
    const d = q.drainSince(0);
    expect(d.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(d.events.map((e) => e.url)).toEqual(['https://a.example', 'https://b.example']);
    expect(d.cursor).toBe(2);
    expect(d.dropped).toBe(0);
  });

  it('does NOT lose events until the cursor advances — a re-drain at the same cursor replays (proxy-failure safe)', () => {
    const q = new StudioEventQueue(100);
    q.enqueue({ type: 'navigation', url: 'x' });
    q.enqueue({ type: 'navigation', url: 'y' });
    expect(q.drainSince(0).events.map((e) => e.seq)).toEqual([1, 2]); // first delivery
    expect(q.drainSince(0).events.map((e) => e.seq)).toEqual([1, 2]); // response lost → re-drain replays, no loss
    expect(q.drainSince(2).events).toEqual([]); // cursor advanced (ack) → trimmed, exactly-once
  });

  it('only returns events newer than the acked cursor; trims the acked ones', () => {
    const q = new StudioEventQueue(100);
    q.enqueue({ type: 'navigation', url: 'a' });
    q.enqueue({ type: 'navigation', url: 'b' });
    expect(q.drainSince(0).cursor).toBe(2);
    q.enqueue({ type: 'navigation', url: 'c' });
    const d = q.drainSince(2); // ack 1,2
    expect(d.events.map((e) => e.url)).toEqual(['c']); // only the new one
    expect(d.cursor).toBe(3);
    expect(q.pending).toBe(1); // 1,2 trimmed
  });

  it('is bounded and FAIL-LOUD on overflow: oldest dropped, dropped count surfaced once', () => {
    const q = new StudioEventQueue(3);
    for (let i = 1; i <= 5; i++) q.enqueue({ type: 'navigation', url: 'u' + i });
    const d = q.drainSince(0);
    expect(d.events.map((e) => e.seq)).toEqual([3, 4, 5]); // oldest 2 dropped
    expect(d.dropped).toBe(2); // surfaced so the consumer can force a full resync
    expect(q.drainSince(5).dropped).toBe(0); // cleared once the cursor advances past the drop (ack)
  });

  it('the dropped signal is cursor-ack-DURABLE: a re-drain at the same cursor REPLAYS dropped (lost-response safe)', () => {
    // WHY: the events are already durable (replayed on a re-drain), but a lost drain
    // RESPONSE crossing the proxy used to swallow the dropped count (it reset every
    // drain) — so the agent would silently proceed on a gappy stream instead of
    // resyncing. The signal must survive a lost response exactly like the events do.
    const q = new StudioEventQueue(3);
    for (let i = 1; i <= 5; i++) q.enqueue({ type: 'navigation', url: 'u' + i }); // overflow → dropped=2 at high-water seq 5
    expect(q.drainSince(0).dropped).toBe(2); // first report
    expect(q.drainSince(0).dropped).toBe(2); // RESPONSE LOST → re-drain at the SAME cursor replays it (was 0 before the fix)
    expect(q.drainSince(5).dropped).toBe(0); // cursor advanced past the drop → ack → cleared
    expect(q.drainSince(5).dropped).toBe(0); // stays cleared (idempotent ack)
  });

  it('does NOT clear dropped on an ack that predates the drop — only a cursor advance PAST the drop clears it', () => {
    // WHY: a consumer acking an old cursor (one below the drop's high-water) has not
    // yet seen the dropped report, so clearing then would lose the gap signal.
    const q = new StudioEventQueue(3);
    q.enqueue({ type: 'navigation', url: 'u1' });
    q.enqueue({ type: 'navigation', url: 'u2' });
    q.enqueue({ type: 'navigation', url: 'u3' }); // [1,2,3] — no drop yet
    q.enqueue({ type: 'navigation', url: 'u4' }); // drop seq1, high-water 4
    q.enqueue({ type: 'navigation', url: 'u5' }); // drop seq2, high-water 5 → dropped=2
    const stale = q.drainSince(3); // ack predates the drops (3 < 5)
    expect(stale.dropped).toBe(2); // still surfaced — the consumer hasn't seen it
    expect(stale.cursor).toBe(5);
    expect(q.drainSince(5).dropped).toBe(0); // advancing past the drop high-water clears it
  });
});
