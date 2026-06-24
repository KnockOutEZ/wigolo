import { useState, useEffect } from 'preact/hooks';
import type { AuditView } from './codec.js';

/**
 * Client-side holder of the SERVER-authoritative audit timeline (7d S4). The host owns the truth; the tab only
 * MIRRORS it: the post-hello `audit_snapshot` (the most-recent backfill → REPLACE) and the live `audit` delta
 * (a newly-recorded action → APPEND). There is NO optimistic/local entry — the client never shows an action
 * the host did not record, and a fresh authoritative snapshot replaces the list rather than merging, so a
 * stale entry can never linger across a reconnect.
 */
export class TimelineModel {
  private entries: AuditView[] = [];
  private readonly subs = new Set<() => void>();

  snapshot(): AuditView[] {
    return [...this.entries];
  }

  /** The post-hello backfill: the host's authoritative set (most-recent N). REPLACES the list, never merges. */
  applySnapshot(entries: AuditView[]): void {
    this.entries = [...entries];
    this.emit();
  }

  /** A live delta: a newly-recorded action appends in arrival (record) order. */
  applyDelta(entry: AuditView): void {
    this.entries.push(entry);
    this.emit();
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }

  private emit(): void {
    for (const cb of this.subs) cb();
  }
}

/** Preact binding: re-render whenever the server-authoritative timeline changes. */
export function useTimelineSnapshot(model: TimelineModel): AuditView[] {
  const [snap, setSnap] = useState<AuditView[]>(model.snapshot());
  useEffect(() => model.subscribe(() => setSnap(model.snapshot())), [model]);
  return snap;
}
