import { describe, it, expect } from 'vitest';
import { SessionMetrics } from '../../../src/studio/metrics.js';

describe('studio/SessionMetrics', () => {
  it('token gauge reflects the source and diverges as tokens advance', () => {
    const m = new SessionMetrics();
    expect(m.read().tokensSpent).toBe(0);
    m.recordTokens(10);
    expect(m.read().tokensSpent).toBe(10);
    m.recordTokens(5); // advance the source → gauge diverges
    expect(m.read().tokensSpent).toBe(15);
    m.recordTokens(-3); // non-positive is ignored, not subtracted
    expect(m.read().tokensSpent).toBe(15);
  });

  it('frame gauges reflect forwarded/dropped frames and diverge as frames drop', () => {
    const m = new SessionMetrics();
    m.recordFrameForwarded();
    m.recordFrameForwarded();
    m.recordFrameForwarded();
    m.recordFrameDropped();
    expect(m.read().framesForwarded).toBe(3);
    expect(m.read().framesDropped).toBe(1);
    m.recordFrameDropped(); // drop another → dropped gauge diverges
    expect(m.read().framesDropped).toBe(2);
    expect(m.read().framesForwarded).toBe(3); // forwarded unchanged by a drop
  });

  it('memory is a PROCESS gauge sourced from process.memoryUsage', () => {
    const m = new SessionMetrics();
    const fixed = m.read(() => ({ rss: 1234, heapTotal: 9, heapUsed: 567, external: 0, arrayBuffers: 0 }));
    expect(fixed.processMemoryRssBytes).toBe(1234);
    expect(fixed.processHeapUsedBytes).toBe(567);
    const live = m.read(); // default source → a real, positive reading
    expect(live.processMemoryRssBytes).toBeGreaterThan(0);
  });

  it('INVARIANT: a read does not mutate the gauges (idempotent reads)', () => {
    const m = new SessionMetrics();
    m.recordTokens(7);
    m.recordFrameForwarded();
    m.recordFrameDropped();
    const a = m.read(() => ({ rss: 1, heapTotal: 1, heapUsed: 1, external: 0, arrayBuffers: 0 }));
    const b = m.read(() => ({ rss: 1, heapTotal: 1, heapUsed: 1, external: 0, arrayBuffers: 0 }));
    expect(b).toEqual(a); // reading twice yields identical counters — read is pure
    expect(m.read().tokensSpent).toBe(7);
    expect(m.read().framesForwarded).toBe(1);
    expect(m.read().framesDropped).toBe(1);
  });
});
