import { describe, it, expect } from 'vitest';
import {
  HeldSnapshot,
  HUMAN_EDIT_KINDS,
  PAGE_CHANGED_BY_HUMAN,
  isHumanEditKind,
  snapshotInvalidatedEvent,
  type SnapshotInvalidation,
} from '../../../../src/studio/perception/held-snapshot.js';
import type { PageSnapshot } from '../../../../src/studio/perception/snapshot.js';

const snap = (id: string): PageSnapshot => ({
  id,
  elements: [{ ref: 'e1', role: 'button', name: 'Go' }],
  tokenCount: 1,
  overBudget: false,
  domTruncated: false,
  refMap: new Map(),
  groupByRef: new Map(),
  domParent: new Map(),
});

describe('HeldSnapshot — the single snapshot-read seam', () => {
  it('reads `none` before anything is held, and `live` after a hold', () => {
    const held = new HeldSnapshot();
    expect(held.read()).toEqual({ state: 'none' });
    held.hold(snap('s1'));
    const r = held.read();
    expect(r.state).toBe('live');
    if (r.state === 'live') expect(r.snapshot.id).toBe('s1');
  });

  it('a human edit makes the held snapshot UNREACHABLE — read never yields it again', () => {
    // The AC's "structurally impossible": there is no accessor that returns the stale
    // PageSnapshot, so a caller cannot serve it even by ignoring the verdict.
    // MUT: have `read()` return {state:'live'} while `invalidatedAt > heldAt` → RED here.
    const held = new HeldSnapshot();
    held.hold(snap('s1'));
    held.humanEdit('key');
    const r = held.read();
    expect(r.state).toBe('invalidated');
    expect(JSON.stringify(r)).not.toContain('s1');
  });

  it('a fresh hold clears the invalidation (the re-read is what makes the page current again)', () => {
    const held = new HeldSnapshot();
    held.hold(snap('s1'));
    held.humanEdit('click');
    expect(held.read().state).toBe('invalidated');
    held.hold(snap('s2'));
    const r = held.read();
    expect(r.state).toBe('live');
    if (r.state === 'live') expect(r.snapshot.id).toBe('s2');
  });

  it('EVERY page-mutating human input shape §5 enumerates trips the trigger', () => {
    // Enumerating the accepted shapes, not only the keystroke that reveals the bug: a trigger
    // wired to one shape passes a single-shape test and misses paste / form change / navigation.
    for (const kind of HUMAN_EDIT_KINDS) {
      const held = new HeldSnapshot();
      held.hold(snap('s1'));
      expect(held.humanEdit(kind), `${kind} must invalidate`).not.toBeNull();
      expect(held.read().state, `${kind} must invalidate`).toBe('invalidated');
    }
  });

  it('navigation is attributed cause=navigation; the other shapes are cause=input', () => {
    const causes = HUMAN_EDIT_KINDS.map((k) => {
      const held = new HeldSnapshot();
      held.hold(snap('s1'));
      return [k, held.humanEdit(k)?.cause] as const;
    });
    expect(Object.fromEntries(causes)).toEqual({
      key: 'input',
      click: 'input',
      paste: 'input',
      form_change: 'input',
      navigation: 'navigation',
    });
  });

  it('a non-page-mutating human input shape is not accepted and does not invalidate', () => {
    // §5's list is the whole definition: a hover or a scroll changes no content, so treating
    // "any human input" as an edit would announce a page change on every mouse move.
    const held = new HeldSnapshot();
    held.hold(snap('s1'));
    for (const kind of ['mouse_move', 'scroll', 'focus', 'selection']) {
      expect(isHumanEditKind(kind)).toBe(false);
      expect(held.humanEditFromWire(kind)).toBeNull();
    }
    expect(held.read().state).toBe('live');
  });

  it('with nothing held, a human edit invalidates nothing (no snapshot was live to go stale)', () => {
    // §5: the trigger fires only "while the run's driver-side snapshot of that tab is live".
    const held = new HeldSnapshot();
    expect(held.humanEdit('key')).toBeNull();
    expect(held.read()).toEqual({ state: 'none' });
  });

  it('a second human edit on an already-invalidated snapshot does not re-announce', () => {
    // One invalidation per stale window: the announcement is "re-read", and it is already pending.
    const held = new HeldSnapshot();
    held.hold(snap('s1'));
    expect(held.humanEdit('key')).not.toBeNull();
    expect(held.humanEdit('paste')).toBeNull();
  });

  it('notifies its sink once per invalidation, with the tab it was constructed for', () => {
    const seen: SnapshotInvalidation[] = [];
    const held = new HeldSnapshot({ tabId: 'tab-7', onInvalidated: (i) => seen.push(i) });
    held.hold(snap('s1'));
    held.humanEdit('form_change');
    held.humanEdit('key'); // already stale — no second notification
    expect(seen).toEqual([{ by: 'human', cause: 'input', kind: 'form_change', tabId: 'tab-7' }]);
  });

  it('a throwing sink never unwinds into the input path that invalidated', () => {
    const held = new HeldSnapshot({ onInvalidated: () => { throw new Error('sink down'); } });
    held.hold(snap('s1'));
    expect(() => held.humanEdit('key')).not.toThrow();
    expect(held.read().state).toBe('invalidated');
  });

  it('the announcement text is §7 row 1 verbatim', () => {
    expect(PAGE_CHANGED_BY_HUMAN).toBe('page changed by human — re-read');
  });
});

describe('snapshotInvalidatedEvent — the run-log envelope', () => {
  it('is a human-actor `snapshot.invalidated` carrying tabId, by and cause', () => {
    const ev = snapshotInvalidatedEvent({ by: 'human', cause: 'input', kind: 'key', tabId: 'tab-7' });
    expect(ev).toEqual({
      actor: { kind: 'human' },
      type: 'snapshot.invalidated',
      payload: { tabId: 'tab-7', by: 'human', cause: 'input' },
    });
  });

  it('omits tabId when the holder is not tab-scoped rather than inventing one', () => {
    const ev = snapshotInvalidatedEvent({ by: 'human', cause: 'navigation', kind: 'navigation' });
    expect(ev.payload).toEqual({ by: 'human', cause: 'navigation' });
  });
});
