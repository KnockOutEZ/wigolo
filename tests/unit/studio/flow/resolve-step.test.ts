/**
 * S13-1 — the offline step resolver: step seed → `heal` → ref. No dispatch.
 *
 * Every halt asserted here is a halt the spec requires (§5.3) and every accept is an accept the
 * spec requires; the tests are written so that removing any one guard reds exactly one of them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveFlowStep,
  HEAL_HALT_CONFIDENCES,
  type StepResolution,
} from '../../../../src/studio/flow/resolve-step.js';
import type { HealCandidate } from '../../../../src/studio/mark/heal.js';
import type { FlowStep, FlowTargetSeed } from '../../../../src/studio/flow/store.js';
import { computeFingerprint } from '../../../../src/studio/perception/id.js';

function seed(over: Partial<FlowTargetSeed> = {}): FlowTargetSeed {
  const role = over.role ?? 'button';
  const name = over.name ?? 'Next page';
  const attrs = over.attrs ?? { type: 'button' };
  return {
    role,
    name,
    fingerprint: over.fingerprint ?? computeFingerprint({ role, name, attrs }),
    ancestorPath: over.ancestorPath ?? 'html/body/div/main/nav',
    attrs,
  };
}

function step(over: Partial<FlowStep> = {}): FlowStep {
  return {
    flowId: 'flw_abc',
    sessionId: 's1',
    seq: 1,
    auditSeq: 7,
    action: 'click',
    pageUrl: 'https://example.com/orders',
    target: seed(),
    recordedRef: 'e-recorded',
    healTierAtRecord: 'high',
    ts: 1,
    ...over,
  };
}

/** A live candidate. `backendNodeId` is legitimate HERE — candidates come from a fresh snapshot. */
function candidate(ref: string, over: Partial<FlowTargetSeed> = {}, backendNodeId = 1): HealCandidate {
  const s = seed(over);
  return { ref, target: { ...s, backendNodeId, trusted: false } };
}

function resolved(r: StepResolution): { ref?: string; reason?: string } {
  return r.ok ? { ref: r.ref } : { reason: r.reason };
}

describe('resolveFlowStep — accepts only what heal is confident about', () => {
  it('resolves a unique-fingerprint seed to the live ref heal chose, at high', () => {
    const r = resolveFlowStep(step(), [candidate('e-live'), candidate('e-other', { name: 'Previous page' })]);
    expect(r).toEqual({ ok: true, ref: 'e-live', confidence: 'high', tier: 'fingerprint' });
  });

  it('returns the LIVE ref, never the recorded one — a recorded ref is a control, not a locator', () => {
    const r = resolveFlowStep(step({ recordedRef: 'e-recorded' }), [candidate('e-live')]);
    expect(r.ok && r.ref).toBe('e-live');
    expect(r.ok && r.ref).not.toBe('e-recorded');
  });

  it('recovers through role+name when the fingerprint drifted (tier 2)', () => {
    // Same role+name, a stable attr changed ⇒ tier 1 misses, tier 2 is unique.
    const cand = candidate('e-live', { attrs: { type: 'submit' } });
    const r = resolveFlowStep(step({ healTierAtRecord: 'medium' }), [cand]);
    expect(r).toEqual({ ok: true, ref: 'e-live', confidence: 'medium', tier: 'role-name' });
  });

  it('splits a role+name run by the ancestor path (tier 3)', () => {
    const a = candidate('e-a', { attrs: { type: 'submit' }, ancestorPath: 'html/body/div/main/nav' });
    const b = candidate('e-b', { attrs: { type: 'submit' }, ancestorPath: 'html/body/div/footer' }, 2);
    const r = resolveFlowStep(step({ healTierAtRecord: 'medium' }), [a, b]);
    expect(r).toEqual({ ok: true, ref: 'e-a', confidence: 'medium', tier: 'path' });
  });
});

describe('resolveFlowStep — halts (§5.3), and never guesses', () => {
  it('HALTS on an ambiguous match and returns NO ref, rather than taking candidate[0]', () => {
    // Two identical fingerprints ⇒ heal `low`. This is the P2 probe's target: a fallback to
    // candidate[0] here is the one failure that produces an automated click on a wrong element.
    const r = resolveFlowStep(step(), [candidate('e-a'), candidate('e-b', {}, 2)]);
    expect(r).toEqual({ ok: false, reason: 'ambiguous_target', confidence: 'low', candidates: 2 });
    expect('ref' in r).toBe(false);
  });

  it('HALTS on a total miss', () => {
    const r = resolveFlowStep(step(), [candidate('e-x', { role: 'link', name: 'Home' })]);
    expect(resolved(r)).toEqual({ reason: 'unresolved_target' });
  });

  it('HALTS when the resolved role differs from the recorded role, even at high confidence', () => {
    // Role is carried by the seed's fingerprint, so a same-fingerprint candidate with a DIFFERENT
    // reported role can only arise from a candidate whose fingerprint was computed elsewhere —
    // which is exactly the inconsistency the check exists to refuse rather than to trust.
    const s = seed();
    const impostor: HealCandidate = {
      ref: 'e-live',
      target: { ...s, role: 'link', backendNodeId: 1, trusted: false },
    };
    const r = resolveFlowStep(step(), [impostor]);
    expect(r).toEqual({
      ok: false,
      reason: 'role_changed',
      confidence: 'high',
      observedRole: 'link',
      recordedRole: 'button',
    });
  });

  it('HALTS when the observed confidence is WORSE than the confidence at record time', () => {
    const cand = candidate('e-live', { attrs: { type: 'submit' } }); // fingerprint drift ⇒ medium
    const r = resolveFlowStep(step({ healTierAtRecord: 'high' }), [cand]);
    expect(r).toEqual({
      ok: false,
      reason: 'confidence_degraded',
      confidence: 'medium',
      confidenceAtRecord: 'high',
    });
  });

  it('does NOT halt when the observed confidence is BETTER than at record time', () => {
    // The halt is asymmetric on purpose: better is not divergence. Without this, a flow recorded
    // during a transient ambiguity could never run again.
    const r = resolveFlowStep(step({ healTierAtRecord: 'medium' }), [candidate('e-live')]);
    expect(r).toEqual({ ok: true, ref: 'e-live', confidence: 'high', tier: 'fingerprint' });
  });

  it('does NOT halt on an equal confidence', () => {
    const cand = candidate('e-live', { attrs: { type: 'submit' } });
    const r = resolveFlowStep(step({ healTierAtRecord: 'medium' }), [cand]);
    expect(r.ok).toBe(true);
  });

  it('HALTS on a step carrying no seed, rather than resolving something else', () => {
    const r = resolveFlowStep(step({ target: undefined }), [candidate('e-live')]);
    expect(resolved(r)).toEqual({ reason: 'missing_seed' });
  });

  it('HALTS on an empty candidate set', () => {
    expect(resolveFlowStep(step(), [])).toEqual({ ok: false, reason: 'unresolved_target', confidence: 'none' });
  });

  it('resolves without a recorded confidence, since the degradation check has nothing to compare', () => {
    const r = resolveFlowStep(step({ healTierAtRecord: undefined }), [candidate('e-live')]);
    expect(r.ok).toBe(true);
  });
});

describe('resolveFlowStep — the resolver stays a CALLER of heal (T6/T14)', () => {
  it('enumerates ONLY the two halting confidences, so a future heal tier is accepted with no change here', () => {
    // T14. Keyed on the halt set rather than on a tier count, so deleting a heal tier leaves this
    // green (P7) while the tier tests above red.
    expect([...HEAL_HALT_CONFIDENCES].sort()).toEqual(['low', 'none']);
  });

  it('names no heal tier in its source, so tier NAMES are never a decision input', () => {
    const src = readFileSync(join(process.cwd(), 'src/studio/flow/resolve-step.ts'), 'utf-8');
    const body = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const tier of ['fingerprint', 'role-name', 'path']) {
      expect(body, `tier name ${tier} is a decision input`).not.toContain(`'${tier}'`);
    }
  });

  it('performs no dispatch — the module imports nothing that can act on a page', () => {
    const src = readFileSync(join(process.cwd(), 'src/studio/flow/resolve-step.ts'), 'utf-8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../mark/heal.js', './store.js']);
  });
});
