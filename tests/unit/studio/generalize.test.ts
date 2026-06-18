import { describe, it, expect } from 'vitest';
import { generalize, applyGeometry, segEditDistance } from '../../../src/studio/mark/generalize.js';
import type { StructuredTarget } from '../../../src/studio/mark/target.js';
import type { HealCandidate } from '../../../src/studio/mark/heal.js';

const t = (o: Partial<StructuredTarget>): StructuredTarget => ({
  backendNodeId: 0,
  role: 'button',
  name: 'Add',
  trusted: false,
  fingerprint: 'fp',
  ancestorPath: 'body/ul/li/button',
  attrs: {},
  ...o,
});
const cand = (ref: string, o: Partial<StructuredTarget>): HealCandidate => ({ ref, target: t(o) });

// The human marked ONE "Add to cart" button in a product list; generalize finds the rest.
const seed = t({ role: 'button', name: 'Add A', ancestorPath: 'body/ul/li/button', backendNodeId: 1 });

describe('segEditDistance — normalized segment-level Levenshtein on the generalized spine', () => {
  it('identical spines → 0', () => {
    expect(segEditDistance('body/ul/li/button', 'body/ul/li/button')).toBe(0);
  });
  it('one extra wrapper segment → 1 edit / longer length', () => {
    // 4 segs vs 5 segs, one insert → 1/5 = 0.2
    expect(segEditDistance('body/ul/li/button', 'body/ul/li/span/button')).toBeCloseTo(0.2, 5);
  });
  it('a fully different spine → 1.0', () => {
    expect(segEditDistance('a/b', 'c/d')).toBe(1);
  });
  it('two empty spines → 0 (no divide-by-zero)', () => {
    expect(segEditDistance('', '')).toBe(0);
  });
});

describe('generalize — mark → the repeating sibling set (structural: role + spine edit-distance)', () => {
  it('an exact-spine repeating list → high, and matches by ROLE+SPINE not name (the list items have different names)', () => {
    const r = generalize(seed, [
      cand('e1', { role: 'button', name: 'Add A', ancestorPath: 'body/ul/li/button', backendNodeId: 1 }), // seed slot
      cand('e2', { role: 'button', name: 'Add B', ancestorPath: 'body/ul/li/button', backendNodeId: 2 }),
      cand('e3', { role: 'button', name: 'Add C', ancestorPath: 'body/ul/li/button', backendNodeId: 3 }),
      cand('e9', { role: 'button', name: 'Subscribe', ancestorPath: 'body/footer/button', backendNodeId: 9 }), // off-spine
    ]);
    expect(r.matches.map((m) => m.ref)).toEqual(['e1', 'e2', 'e3']); // the three list buttons, NOT the footer
    expect(r.confidence).toBe('high');
  });

  it('THE GATE: an off-pattern "Sponsored" sibling (spine differs by ≥2 segments → distance > 0.3) is EXCLUDED', () => {
    const r = generalize(seed, [
      cand('e1', { ancestorPath: 'body/ul/li/button', name: 'Add A', backendNodeId: 1 }),
      cand('e2', { ancestorPath: 'body/ul/li/button', name: 'Add B', backendNodeId: 2 }),
      // a promo row: two extra wrapper segments → 2/6 ≈ 0.33 > 0.3
      cand('eS', { ancestorPath: 'body/ul/li/div/aside/button', name: 'Sponsored', backendNodeId: 7 }),
    ]);
    expect(r.matches.map((m) => m.ref)).toEqual(['e1', 'e2']);
    expect(r.matches.find((m) => m.ref === 'eS')).toBeUndefined();
  });

  it('NON-VACUITY of the gate: widening maxDistance to Infinity DOES pull the off-pattern row in (so the ≤0.3 gate is what excluded it)', () => {
    const cands = [
      cand('e1', { ancestorPath: 'body/ul/li/button', name: 'Add A', backendNodeId: 1 }),
      cand('e2', { ancestorPath: 'body/ul/li/button', name: 'Add B', backendNodeId: 2 }),
      cand('eS', { ancestorPath: 'body/ul/li/div/aside/button', name: 'Sponsored', backendNodeId: 7 }),
    ];
    expect(generalize(seed, cands).matches.map((m) => m.ref)).toEqual(['e1', 'e2']); // gated out at 0.3
    expect(generalize(seed, cands, { maxDistance: Infinity }).matches.map((m) => m.ref)).toEqual(['e1', 'e2', 'eS']); // gate removed → in
  });

  it('a LOOSENED sibling (one extra wrapper, distance 0.2 ≤ 0.3) is included but downgrades the set to medium', () => {
    const r = generalize(seed, [
      cand('e1', { ancestorPath: 'body/ul/li/button', name: 'Add A', backendNodeId: 1 }),
      cand('e2', { ancestorPath: 'body/ul/li/span/button', name: 'Add B', backendNodeId: 2 }), // +1 wrapper
    ]);
    expect(r.matches.map((m) => m.ref)).toEqual(['e1', 'e2']);
    expect(r.confidence).toBe('medium'); // not all exact-spine → inspect
  });

  it('ROLE is required: a same-spine-shaped candidate with a DIFFERENT role is excluded (a link beside each button)', () => {
    const r = generalize(seed, [
      cand('e1', { role: 'button', ancestorPath: 'body/ul/li/button', name: 'Add A', backendNodeId: 1 }),
      cand('e2', { role: 'button', ancestorPath: 'body/ul/li/button', name: 'Add B', backendNodeId: 2 }),
      // a link in the same row: spine ends /a (distance 0.25 ≤ 0.3) but role 'link' ≠ 'button'
      cand('eL', { role: 'link', ancestorPath: 'body/ul/li/a', name: 'Details', backendNodeId: 5 }),
    ]);
    expect(r.matches.map((m) => m.ref)).toEqual(['e1', 'e2']);
  });

  it('NO repeating pattern (the seed is unique) → none, empty set — nothing to generalize', () => {
    const r = generalize(seed, [cand('e1', { ancestorPath: 'body/ul/li/button', name: 'Add A', backendNodeId: 1 })]);
    expect(r.confidence).toBe('none');
    expect(r.matches).toEqual([]);
  });

  it('an empty seed role → none (too weak to generalize, mirrors the heal guard)', () => {
    const r = generalize(t({ role: '', ancestorPath: 'body/ul/li/button' }), [
      cand('e1', { role: '', ancestorPath: 'body/ul/li/button', backendNodeId: 1 }),
      cand('e2', { role: '', ancestorPath: 'body/ul/li/button', backendNodeId: 2 }),
    ]);
    expect(r.confidence).toBe('none');
    expect(r.matches).toEqual([]);
  });
});

describe('applyGeometry — minimal geometric tiebreaker over the structural set (preview-only)', () => {
  const structural = (refs: string[], confidence: 'high' | 'medium' | 'low' | 'none') => ({
    matches: refs.map((ref, i) => ({ ref, backendNodeId: i + 1, distance: 0 })),
    confidence,
  });
  const box = (x: number, y: number) => ({ x, y, width: 100, height: 40 });

  const outlierBoxes = () =>
    new Map([
      ['e3', box(0, 200)],
      ['e1', box(0, 0)],
      ['e2', box(0, 100)],
      ['eOut', box(0, 9000)], // a same-structured button 9000px away — not part of this visual list
    ]);

  it('prunes a gross visual outlier and sorts the kept refs top-to-bottom', () => {
    const r = applyGeometry(structural(['e3', 'e1', 'e2', 'eOut'], 'high'), outlierBoxes());
    expect(r.refs).toEqual(['e1', 'e2', 'e3']); // outlier dropped, rest sorted by y
    expect(r.requires_confirmation).toBe(true);
  });

  it('pruning a structural match downgrades the confidence high → medium', () => {
    const r = applyGeometry(structural(['e3', 'e1', 'e2', 'eOut'], 'high'), outlierBoxes());
    expect(r.confidence).toBe('medium'); // the visual irregularity lowers certainty
  });

  it('with NO boxes it cannot refine — keeps the structural order + confidence (not rendered ≠ off-pattern; the human confirms)', () => {
    const r = applyGeometry(structural(['e1', 'e2', 'e3'], 'high'), new Map());
    expect(r.refs).toEqual(['e1', 'e2', 'e3']);
    expect(r.confidence).toBe('high');
    expect(r.requires_confirmation).toBe(true);
  });

  it('a REGULAR grid is NOT false-pruned — uniform spacing keeps every item and the confidence (high stays high)', () => {
    const boxes = new Map([
      ['e1', box(0, 0)],
      ['e2', box(0, 100)],
      ['e3', box(0, 200)],
    ]);
    const r = applyGeometry(structural(['e2', 'e3', 'e1'], 'high'), boxes);
    expect(r.refs).toEqual(['e1', 'e2', 'e3']); // sorted, none dropped
    expect(r.confidence).toBe('high');
  });

  it('always requires_confirmation — generalize is a preview READ, never an act', () => {
    expect(applyGeometry(structural([], 'none'), new Map()).requires_confirmation).toBe(true);
    expect(applyGeometry(structural(['e1', 'e2'], 'high'), new Map()).requires_confirmation).toBe(true);
  });
});
