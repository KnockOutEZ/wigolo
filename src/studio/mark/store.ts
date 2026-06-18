/**
 * In-memory store of the human's marks for one session — the structured targets the agent
 * reads via `studio_marks` and acts on. Phase 3 holds marks in memory only; durable capture
 * into the cache is Phase 4. A mark is a stable session-scoped id + its structured target.
 */
import type { StructuredTarget } from './target.js';

export interface StudioMark {
  /** Session-scoped, agent-facing id (e.g. `m1`). Distinct from a snapshot ref (`e…`). */
  markId: string;
  target: StructuredTarget;
}

export class MarkStore {
  private readonly marks: StudioMark[] = [];
  private seq = 0;

  /** Record a marked element; returns the stored mark (with its new id). */
  add(target: StructuredTarget): StudioMark {
    const mark: StudioMark = { markId: 'm' + ++this.seq, target };
    this.marks.push(mark);
    return mark;
  }

  /** All marks, in insertion order. Returns a copy so callers can't mutate the store. */
  list(): StudioMark[] {
    return [...this.marks];
  }

  get(markId: string): StudioMark | undefined {
    return this.marks.find((m) => m.markId === markId);
  }
}
