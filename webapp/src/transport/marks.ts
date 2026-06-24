import { useState, useEffect } from 'preact/hooks';
import type { MarkView } from './codec.js';

/**
 * Client-side holder of the SERVER-authoritative marks list (7c S4). The host owns the truth; the tab only
 * MIRRORS it: the post-hello `marks_snapshot` (the complete set → replace) and the live `mark` delta (upsert
 * by id). There is NO optimistic/local add — the client never shows a mark the server did not send, so a
 * forged or speculative entry can never reach the human read surface.
 */
export class MarksModel {
  private marks: MarkView[] = [];
  private readonly subs = new Set<() => void>();

  snapshot(): MarkView[] {
    return [...this.marks];
  }

  /** The post-hello backfill: the host's COMPLETE set this session. Authoritative — REPLACES the list, never merges. */
  applySnapshot(marks: MarkView[]): void {
    this.marks = [...marks];
    this.emit();
  }

  /** A live delta: upsert by markId (a re-heal of the same mark replaces in place; a new mark appends). */
  applyDelta(mark: MarkView): void {
    const i = this.marks.findIndex((m) => m.markId === mark.markId);
    if (i >= 0) this.marks[i] = mark;
    else this.marks.push(mark);
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

/** Preact binding: re-render whenever the model's server-authoritative list changes. */
export function useMarksSnapshot(model: MarksModel): MarkView[] {
  const [snap, setSnap] = useState<MarkView[]>(model.snapshot());
  useEffect(() => model.subscribe(() => setSnap(model.snapshot())), [model]);
  return snap;
}
