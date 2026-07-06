// Renderer-side captures state for the Captures rail pane (mirrors marks-store's Map + subscribers).
// Captures arrive two ways: a full `set()` on session open (via listCaptures) and a live `add()` per
// captureAdded delta (a real insert the broker pushed). Dedup by artifact id so a delta that races the
// initial list never double-lists.
import type { CaptureDto } from '../shared/ipc';

export interface CapturesStore {
  list(): CaptureDto[];
  /** Replace the full set from a host list (session open). */
  set(items: CaptureDto[]): void;
  /** Add one captured item from a live delta (dedup by id — no double-list). */
  add(item: CaptureDto): void;
  subscribe(cb: () => void): void;
}

export function createCapturesStore(): CapturesStore {
  const items = new Map<number, CaptureDto>();
  const subscribers = new Set<() => void>();
  const notify = (): void => { for (const cb of subscribers) cb(); };

  return {
    list(): CaptureDto[] {
      // Newest first — the rail reads top-down.
      return [...items.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
    },
    set(next: CaptureDto[]): void {
      items.clear();
      for (const c of next) items.set(c.id, c);
      notify();
    },
    add(item: CaptureDto): void {
      if (items.has(item.id)) return; // dedup — a delta that races the initial list
      items.set(item.id, item);
      notify();
    },
    subscribe(cb: () => void): void {
      subscribers.add(cb);
    },
  };
}
