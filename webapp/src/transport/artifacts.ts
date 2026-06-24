import { useState, useEffect } from 'preact/hooks';
import type { ArtifactView } from './codec.js';

/**
 * Client-side holder of the SERVER-authoritative captured-items list (7e S3). The host owns the truth; the tab
 * only MIRRORS it: the post-hello `artifact_snapshot` (the complete set → replace) and the live `artifact`
 * delta (upsert by id). There is NO optimistic/local add — the client never shows a captured item the server
 * did not send. Mirrors MarksModel / CommentsModel.
 */
export class ArtifactsModel {
  private items: ArtifactView[] = [];
  private readonly subs = new Set<() => void>();

  snapshot(): ArtifactView[] {
    return [...this.items];
  }

  /** The post-hello backfill: the host's COMPLETE captured set this session. Authoritative — REPLACES, never merges. */
  applySnapshot(items: ArtifactView[]): void {
    this.items = [...items];
    this.emit();
  }

  /** A live delta: upsert by id (a re-broadcast of the same captured item replaces in place; a new one appends). */
  applyDelta(item: ArtifactView): void {
    const i = this.items.findIndex((x) => x.id === item.id);
    if (i >= 0) this.items[i] = item;
    else this.items.push(item);
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
export function useArtifactsSnapshot(model: ArtifactsModel): ArtifactView[] {
  const [snap, setSnap] = useState<ArtifactView[]>(model.snapshot());
  useEffect(() => model.subscribe(() => setSnap(model.snapshot())), [model]);
  return snap;
}
