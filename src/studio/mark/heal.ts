/**
 * Self-healing locator cascade (HANDOFF §3 heal). A `StructuredTarget` outlives the observe it
 * was marked in; after DOM drift its stored backend node id is stale. `heal` re-resolves the
 * seed against the CURRENT page's candidate targets through degrading tiers, returning the live
 * snapshot `ref` of a confident match — which the EXISTING 2J resolver then takes to coords +
 * occlusion + dispatch. Heal does mark→ref; the resolver does ref→action. There is no parallel
 * resolver, and the ref it returns is the same one the preview/dispatch path uses.
 *
 * Tiers (strongest → weakest):
 *  1. fingerprint  — role+name+stable-attr hash (id.ts); unique match → high.
 *  2. role+name    — a stable attr drifted but the a11y identity holds; unique → medium.
 *  3. path         — disambiguate a role+name run by the generalized ancestor-path spine → medium.
 *  (4. visual      — geometric fallback; deferred this slice — a structural miss is `none`.)
 *
 * Ambiguity (≥2 identical-fingerprint, or a role+name run the path can't split) → `low`: the
 * caller ASKS / re-observes and never acts on a guess — the 2J.1 single-element discipline,
 * now for marks. A total miss → `none` (not found, never a wrong element).
 */
import type { StructuredTarget } from './target.js';

export type HealConfidence = 'high' | 'medium' | 'low' | 'none';

export interface HealCandidate {
  /** The candidate's CURRENT snapshot ref (host pairs it from the fresh snapshot's refMap). */
  ref: string;
  target: StructuredTarget;
}

export interface HealResult {
  confidence: HealConfidence;
  /** Set ONLY for a single confident match (high/medium): the live ref the 2J resolver resolves. */
  ref?: string;
  backendNodeId?: number;
  tier?: 'fingerprint' | 'role-name' | 'path';
  /** For an ambiguous `low` result: how many candidates matched at the deciding tier. */
  candidates?: number;
}

export function heal(seed: StructuredTarget, candidates: HealCandidate[]): HealResult {
  // Tier 1 — fingerprint (role+name+stable-attrs): the strongest, position-free locator.
  const fp = candidates.filter((c) => c.target.fingerprint === seed.fingerprint);
  if (fp.length === 1) return { confidence: 'high', ref: fp[0].ref, backendNodeId: fp[0].target.backendNodeId, tier: 'fingerprint' };
  if (fp.length >= 2) return { confidence: 'low', tier: 'fingerprint', candidates: fp.length }; // identical-fingerprint siblings

  // Tier 2 — role + name (a stable attr drifted, the a11y identity holds). An empty role is too
  // weak to match on (it would collide across every unnamed node), so require a non-empty role.
  const rn = seed.role ? candidates.filter((c) => c.target.role === seed.role && c.target.name === seed.name) : [];
  if (rn.length === 1) return { confidence: 'medium', ref: rn[0].ref, backendNodeId: rn[0].target.backendNodeId, tier: 'role-name' };
  if (rn.length >= 2) {
    // Tier 3 — disambiguate the role+name run by the generalized ancestor-path spine.
    const p = rn.filter((c) => c.target.ancestorPath === seed.ancestorPath);
    if (p.length === 1) return { confidence: 'medium', ref: p[0].ref, backendNodeId: p[0].target.backendNodeId, tier: 'path' };
    return { confidence: 'low', tier: 'role-name', candidates: rn.length }; // still ambiguous → ask, never guess
  }

  return { confidence: 'none' }; // structural miss (visual fallback deferred) → not found
}
