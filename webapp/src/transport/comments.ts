import { useState, useEffect } from 'preact/hooks';
import type { CommentView } from './codec.js';

/**
 * Client-side holder of the SERVER-authoritative comments list (7b-notes S3). The host owns the truth; the tab
 * only MIRRORS it: the post-hello `comment_snapshot` (the complete set → replace) and the live `comment` echo
 * delta (upsert by id). There is NO optimistic/local add — a locally-typed comment appears only once the host
 * echoes it back, so the human never sees a comment that was not actually captured (no-silent-failure). Upsert
 * by id makes a deduped re-echo of the same captured note idempotent rather than a duplicate row.
 */
export class CommentsModel {
  private comments: CommentView[] = [];
  private readonly subs = new Set<() => void>();

  snapshot(): CommentView[] {
    return [...this.comments];
  }

  /** The post-hello backfill: the host's COMPLETE comment set this session. Authoritative — REPLACES, never merges. */
  applySnapshot(comments: CommentView[]): void {
    this.comments = [...comments];
    this.emit();
  }

  /** A live echo delta: upsert by id (a re-echo of the same captured note replaces in place; a new note appends). */
  applyDelta(comment: CommentView): void {
    const i = this.comments.findIndex((c) => c.id === comment.id);
    if (i >= 0) this.comments[i] = comment;
    else this.comments.push(comment);
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
export function useCommentsSnapshot(model: CommentsModel): CommentView[] {
  const [snap, setSnap] = useState<CommentView[]>(model.snapshot());
  useEffect(() => model.subscribe(() => setSnap(model.snapshot())), [model]);
  return snap;
}
