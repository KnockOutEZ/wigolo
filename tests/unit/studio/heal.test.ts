import { describe, it, expect } from 'vitest';
import { heal } from '../../../src/studio/mark/heal.js';
import type { StructuredTarget } from '../../../src/studio/mark/target.js';

const t = (o: Partial<StructuredTarget>): StructuredTarget => ({
  backendNodeId: 0,
  role: 'button',
  name: 'Buy',
  trusted: false,
  fingerprint: 'fp',
  ancestorPath: 'body/div/button',
  attrs: {},
  ...o,
});
const cand = (ref: string, o: Partial<StructuredTarget>) => ({ ref, target: t(o) });

// The seed mark to re-resolve after drift.
const seed = t({ fingerprint: 'FP-seed', role: 'button', name: 'Delete', ancestorPath: 'body/ul/li/button' });

describe('heal — self-healing locator cascade (mark → live ref)', () => {
  it('tier 1 fingerprint: a UNIQUE fingerprint match → high confidence + the live ref (the bridge to the 2J resolver)', () => {
    const r = heal(seed, [
      cand('e1', { fingerprint: 'FP-seed', backendNodeId: 11 }),
      cand('e2', { fingerprint: 'OTHER', backendNodeId: 22 }),
    ]);
    expect(r).toMatchObject({ confidence: 'high', ref: 'e1', backendNodeId: 11, tier: 'fingerprint' });
  });

  it('tier 1 ambiguous: ≥2 identical-fingerprint candidates → low (ask), NO actionable ref', () => {
    const r = heal(seed, [
      cand('e1', { fingerprint: 'FP-seed', backendNodeId: 11 }),
      cand('e2', { fingerprint: 'FP-seed', backendNodeId: 22 }),
    ]);
    expect(r.confidence).toBe('low');
    expect(r.ref).toBeUndefined();
    expect(r.candidates).toBe(2);
  });

  it('tier 2 role+name: fingerprint missed (a stable attr drifted) but a UNIQUE role+name → medium', () => {
    const r = heal(seed, [
      cand('e9', { fingerprint: 'DRIFTED', role: 'button', name: 'Delete', backendNodeId: 9 }),
      cand('e8', { fingerprint: 'X', role: 'button', name: 'Edit', backendNodeId: 8 }),
    ]);
    expect(r).toMatchObject({ confidence: 'medium', ref: 'e9', backendNodeId: 9, tier: 'role-name' });
  });

  it('tier 3 path: role+name is ambiguous, the GENERALIZED ancestor-path disambiguates → medium', () => {
    const r = heal(seed, [
      cand('eA', { fingerprint: 'D1', role: 'button', name: 'Delete', ancestorPath: 'body/ul/li/button', backendNodeId: 1 }),
      cand('eB', { fingerprint: 'D2', role: 'button', name: 'Delete', ancestorPath: 'body/footer/button', backendNodeId: 2 }),
    ]);
    expect(r).toMatchObject({ confidence: 'medium', ref: 'eA', backendNodeId: 1, tier: 'path' });
  });

  it('role+name AND path both ambiguous → low (ask, never guess which sibling)', () => {
    const r = heal(seed, [
      cand('eA', { fingerprint: 'D1', role: 'button', name: 'Delete', ancestorPath: 'body/ul/li/button', backendNodeId: 1 }),
      cand('eB', { fingerprint: 'D2', role: 'button', name: 'Delete', ancestorPath: 'body/ul/li/button', backendNodeId: 2 }),
    ]);
    expect(r.confidence).toBe('low');
    expect(r.ref).toBeUndefined();
  });

  it('tier PRECEDENCE: a fingerprint-unique match wins over a DIFFERENT role+name match (fingerprint tier runs first)', () => {
    // eA matches the seed's fingerprint (tier 1) but NOT its role+name; eB matches role+name
    // (tier 2) but not the fingerprint. Heal must take eA via tier 1 — a reorder to role+name-first
    // would return eB/medium/role-name and redden this.
    const r = heal(seed, [
      cand('eA', { fingerprint: 'FP-seed', role: 'button', name: 'NOT-THE-NAME', backendNodeId: 1 }),
      cand('eB', { fingerprint: 'DIFFERENT', role: 'button', name: 'Delete', backendNodeId: 2 }),
    ]);
    expect(r).toMatchObject({ confidence: 'high', ref: 'eA', backendNodeId: 1, tier: 'fingerprint' });
  });

  it('nothing matches by any tier → none (not found — never a wrong element)', () => {
    const r = heal(seed, [cand('eX', { fingerprint: 'X', role: 'link', name: 'Home', ancestorPath: 'body/nav/a', backendNodeId: 7 })]);
    expect(r.confidence).toBe('none');
    expect(r.ref).toBeUndefined();
  });
});
