// Renderer-side marks state for the Marks rail pane (mirrors approval-store's Map + subscribers).
// Marks arrive from the host via IPC (marksChanged) as MarkDto[] — role/name are page-derived
// (untrusted, host-neutralized). Comments are renderer-local (human-authored in the panel); they
// are preserved across a heal-refresh re-push and also sent to the host (for the agent's observe
// drain) by the caller. Agent replies to comments are P4.
import type { MarkDto } from '../shared/ipc';

export interface Mark extends MarkDto {
  comments: string[];
}

export interface MarksStore {
  list(): Mark[];
  /** Replace the full mark set from a host push, preserving local comments for surviving markIds. */
  set(marks: MarkDto[]): void;
  /** Append a human comment to a mark (no-op for an unknown id). */
  appendComment(markId: string, text: string): void;
  subscribe(cb: () => void): void;
}

export function createMarksStore(): MarksStore {
  const items = new Map<string, Mark>();
  const subscribers = new Set<() => void>();
  const notify = (): void => { for (const cb of subscribers) cb(); };

  return {
    list(): Mark[] {
      return [...items.values()];
    },
    set(marks: MarkDto[]): void {
      const next = new Map<string, Mark>();
      for (const dto of marks) {
        const prior = items.get(dto.markId);
        next.set(dto.markId, { ...dto, comments: prior?.comments ?? [] });
      }
      items.clear();
      for (const [k, v] of next) items.set(k, v);
      notify();
    },
    appendComment(markId: string, text: string): void {
      const m = items.get(markId);
      if (!m) return;
      m.comments = [...m.comments, text];
      notify();
    },
    subscribe(cb: () => void): void {
      subscribers.add(cb);
    },
  };
}
