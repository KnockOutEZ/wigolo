/**
 * S13-1 — the two-arm drift benchmark behind gate G2: *does healing actually beat what the audit
 * already permits?*
 *
 * Two arms over IDENTICAL cases, each case being (a recorded flow step seed) × (one mutation of the
 * frozen C0 page it was recorded against):
 *
 *  - **arm A — ref equality only.** Recompute refs on the drifted page and match the recorded ref
 *    string. This is the resolver `studio_audit` alone supports, so it is the honest baseline: it is
 *    what S13 would ship if seeds bought nothing.
 *  - **arm B — seed + `heal()`**, tiers 1–3, through the shipped `resolveFlowStep`.
 *
 * Both arms consume the SAME stored steps, round-tripped through the shipped flow store, so arm B
 * is measured on exactly the seed a replay would read — not on a richer in-memory target.
 *
 * ── Why the expected verdicts are computed from the ORIGINAL page, never the drifted one ─────────
 * A benchmark whose expected value is derived from the artifact it scores is a pin, not a check. So
 * the oracle here is built on the un-mutated document and on a property of the mutation engine that
 * is verified separately (`mutationPreservesRawElements`): the five §3.4 classes rewrite attributes and
 * nesting, and REMOVE no interactive element. Given that, a seed that was uniquely identified on the
 * original page names an element that still exists on the drifted page, so `resolve` is the correct
 * verdict and any refusal is a miss rather than a judgement call. The must-REFUSE cases are
 * constructed independently of both pages (an absent fingerprint, a duplicated identity) because the
 * §3.4 classes produce no refusal at all — which is itself a reportable property of the corpus.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { buildSnapshot, flattenDom, type AxNode, type DomNode } from '../../src/studio/perception/snapshot.js';
import { buildTargetFromFlat, indexAxByBackendNode } from '../../src/studio/mark/target.js';
import { STABLE_ATTRS, computeFingerprint } from '../../src/studio/perception/id.js';
import type { HealCandidate } from '../../src/studio/mark/heal.js';
import { projectFlowStep, insertFlowStep, listFlowSteps, flowIdForSession, type FlowStep } from '../../src/studio/flow/store.js';
import { resolveFlowStep } from '../../src/studio/flow/resolve-step.js';
import { mutate, MUTATION_CLASSES, type MutationClass } from './drift.js';

export const FIXTURE_DIR = join(process.cwd(), 'benchmarks/scrape-quality/fixtures/html');

// ---------------------------------------------------------------------------
// Frozen HTML → the (accessibility ⋈ pierced DOM) shape the perception layer consumes
// ---------------------------------------------------------------------------

const ROLE_BY_TAG: Record<string, string> = {
  button: 'button', a: 'link', select: 'combobox', textarea: 'textbox', option: 'option',
};
const ROLE_BY_INPUT_TYPE: Record<string, string> = {
  text: 'textbox', search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
  password: 'textbox', checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button',
};

function roleOf(tag: string, attrs: Record<string, string>): string | undefined {
  if (attrs['role']) return attrs['role'];
  if (tag === 'input') return ROLE_BY_INPUT_TYPE[(attrs['type'] ?? 'text').toLowerCase()];
  if (tag === 'a' && attrs['href'] === undefined) return undefined;
  return ROLE_BY_TAG[tag];
}

interface PageView {
  /** Every interactive element's live ref → its structured target, as a fresh snapshot would pair them. */
  candidates: HealCandidate[];
  refs: Set<string>;
  interactiveCount: number;
}

/**
 * The harness's approximation of an accessibility tree, derived from frozen HTML. The approximation
 * is the HARNESS's; everything downstream of it — fingerprints, refs, structured targets, the heal
 * cascade, the resolver — is the shipped code, which is what G2 is about.
 */
export function pageView(html: string): PageView {
  const { document } = parseHTML(html);
  const ax: AxNode[] = [];
  let nextId = 1;

  const toNode = (el: Element, depth: number): DomNode => {
    const backendNodeId = nextId++;
    const tag = el.tagName.toLowerCase();
    const attrs: Record<string, string> = {};
    const flat: string[] = [];
    for (const a of Array.from(el.attributes)) {
      attrs[a.name] = a.value;
      flat.push(a.name, a.value);
    }
    const role = roleOf(tag, attrs);
    if (role) {
      const name = (attrs['aria-label'] ?? el.textContent?.trim() ?? '').replace(/\s+/g, ' ').slice(0, 120)
        || attrs['placeholder'] || attrs['title'] || attrs['value'] || '';
      ax.push({ role: { value: role }, name: { value: name }, backendDOMNodeId: backendNodeId });
    }
    // The frozen fixtures are real megabyte-scale pages; bound the walk so the harness stays fast.
    // The SAME bounds apply to the original and to every variant, so a case is never scored against
    // a differently-truncated view of its own page.
    const children = depth < 40
      ? Array.from(el.children).slice(0, 400).map((c) => toNode(c as Element, depth + 1))
      : [];
    return { backendNodeId, nodeType: 1, localName: tag, nodeName: tag.toUpperCase(), attributes: flat, children };
  };

  const root: DomNode = {
    backendNodeId: 0, nodeType: 9, localName: '#document', nodeName: '#document',
    children: [toNode(document.documentElement, 0)],
  };

  const snapshot = buildSnapshot(ax, root, { tokenBudget: 1_000_000 });
  const flat = flattenDom(root).map;
  const axIndex = indexAxByBackendNode(ax);
  const candidates: HealCandidate[] = [];
  for (const el of snapshot.elements) {
    const be = snapshot.refMap.get(el.ref);
    if (be == null) continue;
    const target = buildTargetFromFlat(flat, axIndex, be);
    if (target) candidates.push({ ref: el.ref, target });
  }
  return { candidates, refs: new Set(snapshot.elements.map((e) => e.ref)), interactiveCount: snapshot.elements.length };
}

// ---------------------------------------------------------------------------
// Seeds — recorded through the shipped flow store, so arm B reads what a replay reads
// ---------------------------------------------------------------------------

function migratedDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

/**
 * The elements a recorded flow's targeted steps would carry: the first few links/buttons and text
 * fields the recorder could act on. Low-confidence (identical-sibling) refs are excluded because the
 * live resolver refuses them, so a recording cannot contain one — the same filter G1 records under.
 */
function recordableElements(view: PageView): HealCandidate[] {
  const actionable = view.candidates.filter((c) => {
    const role = c.target.role;
    return role === 'link' || role === 'button' || role === 'textbox' || role === 'searchbox';
  });
  const unique = new Map<string, HealCandidate[]>();
  for (const c of actionable) {
    const list = unique.get(c.target.fingerprint) ?? [];
    list.push(c);
    unique.set(c.target.fingerprint, list);
  }
  const solo = actionable.filter((c) => (unique.get(c.target.fingerprint) ?? []).length === 1);
  return [
    ...solo.filter((c) => c.target.role === 'link' || c.target.role === 'button').slice(0, 4),
    ...solo.filter((c) => c.target.role === 'textbox' || c.target.role === 'searchbox').slice(0, 2),
  ];
}

export interface Seed {
  fixture: string;
  step: FlowStep;
  /** The ref minted on the ORIGINAL page — arm A's whole locator. */
  recordedRef: string;
}

function storeSeeds(db: Database.Database, fixture: string, view: PageView): Seed[] {
  const sessionId = `g2-${fixture}`;
  const flowId = flowIdForSession(sessionId);
  const out: Seed[] = [];
  let seq = 0;
  for (const el of recordableElements(view)) {
    seq += 1;
    // The SHIPPED writer projection, so the stored seed's attrs are the allow-listed subset a
    // replay would read — not the full attribute set the in-memory target carries.
    const projected = projectFlowStep({
      flowId, sessionId, seq, auditSeq: seq, action: 'click',
      pageUrl: `https://example.invalid/${fixture}`,
      target: {
        role: el.target.role, name: el.target.name, fingerprint: el.target.fingerprint,
        ancestorPath: el.target.ancestorPath,
        attrs: Object.fromEntries(STABLE_ATTRS.filter((k) => el.target.attrs[k] != null).map((k) => [k, el.target.attrs[k]])),
      },
      recordedRef: el.ref, healTierAtRecord: 'high', ts: seq,
    });
    if (!projected.ok) continue;
    insertFlowStep(db, projected.step);
  }
  for (const step of listFlowSteps(db, flowId)) {
    if (step.recordedRef) out.push({ fixture, step, recordedRef: step.recordedRef });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The two arms
// ---------------------------------------------------------------------------

export type ArmOutcome =
  | { resolved: true; ref: string; role: string | undefined; confidence: string }
  | { resolved: false; reason: string };

/** arm A: the recorded ref string, matched against the drifted page's refs. Nothing else. */
export function armA(seed: Seed, view: PageView): ArmOutcome {
  if (!view.refs.has(seed.recordedRef)) return { resolved: false, reason: 'ref_absent' };
  const hit = view.candidates.find((c) => c.ref === seed.recordedRef);
  return { resolved: true, ref: seed.recordedRef, role: hit?.target.role, confidence: 'exact' };
}

/** arm B: the shipped resolver — seed → `heal` tiers 1–3 → ref, with §5.3's halts. */
export function armB(seed: Seed, view: PageView): ArmOutcome {
  const r = resolveFlowStep(seed.step, view.candidates);
  if (!r.ok) return { resolved: false, reason: r.reason };
  const hit = view.candidates.find((c) => c.ref === r.ref);
  return { resolved: true, ref: r.ref, role: hit?.target.role, confidence: r.confidence };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ArmTally {
  cases: number;
  resolved: number;
  /** Resolved a ref whose role differs from the recorded role, OR resolved a must-REFUSE case. */
  wrong: number;
  refusalsByReason: Record<string, number>;
}

export interface FlowDriftReport {
  fixtures: number;
  fixturesWithSeeds: number;
  seeds: number;
  cases: number;
  a: ArmTally;
  b: ArmTally;
  /** Cases arm A resolves that arm B does not. Expected 0 — they key on the same fingerprint. */
  aOnly: number;
  /** Cases arm B resolves that arm A does not. This is the number G2's threshold is written on. */
  bOnly: number;
  /** `heal_tier_at_record` → observed confidence, e.g. `high->medium` (§11.A.6). */
  tierTransitions: Record<string, number>;
  perMutation: Record<string, { cases: number; a: number; b: number; bOnly: number; wrongA: number; wrongB: number }>;
  /**
   * The ORACLE'S PREMISE, checked on the raw HTML strings and therefore independent of the snapshot
   * layer, the fingerprint and `heal` alike: no §3.4 mutation removes an interactive element. A check
   * run through the perception layer would share its truncation behaviour with the thing it certifies.
   */
  mutationPreservesRawElements: boolean;
  /**
   * Diagnostic, NOT the premise: how the harness's own snapshot count moves per mutation. A negative
   * delta is a harness artifact — the walk caps a node's children at 400, so REORDERING a `<tbody>`
   * with more rows than that admits a different subset. Recorded so the artifact stays named instead
   * of being rediscovered as a mystery.
   */
  harnessViewDelta: Record<string, number>;
  /**
   * Seeds whose stable-attr slice is EMPTY. For those, `computeFingerprint` reduces to `role\0name\0`,
   * so heal tier 2 (role+name) matches exactly the candidate set tier 1 already matched — tier 2
   * cannot recover what tier 1 missed. The structural reason arm B ≈ arm A on this corpus.
   */
  seedsWithoutStableAttrs: number;
  /**
   * Split by kind, because the two kinds are refused for different reasons and only one of them is a
   * case arm A can even attempt: an ABSENT identity has no ref on any page, so arm A trivially
   * refuses it, while an AMBIGUOUS identity has a positionally-tiebroken ref that arm A may still
   * match — resolving to one member of an identical-sibling run it cannot tell apart. Reporting only
   * the total would let the trivial half dilute the rate on the half that discriminates.
   */
  mustRefuse: {
    cases: number;
    aFired: number;
    bFired: number;
    absentCases: number;
    absentAFired: number;
    ambiguousCases: number;
    ambiguousAFired: number;
  };
}

/**
 * Interactive-element openers in the raw markup. Counted on the STRING so the premise
 * ("the mutation removes no element") is established without the snapshot layer, the fingerprint, or
 * `heal` — none of which may be an input to the oracle that scores them.
 */
const INTERACTIVE_TAG = /<(?:a|button|input|select|textarea)\b/gi;

function rawInteractiveCount(html: string): number {
  return (html.match(INTERACTIVE_TAG) ?? []).length;
}

function emptyTally(): ArmTally {
  return { cases: 0, resolved: 0, wrong: 0, refusalsByReason: {} };
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

/**
 * Cases that MUST be refused, constructed from neither page so the oracle cannot agree with the
 * resolver by construction. Without these the "wrong resolution" row is vacuous: a corpus of
 * only-must-resolve cases cannot catch over-firing, and over-firing is the silent-wrong failure the
 * binding half of G2 exists to detect.
 */
type MustRefuseKind = 'absent' | 'ambiguous';

function mustRefuseSeeds(base: Seed, original: PageView): Array<Seed & { kind: MustRefuseKind }> {
  const t = base.step.target;
  if (!t) return [];
  const out: Array<Seed & { kind: MustRefuseKind }> = [];

  // (1) ABSENT — an identity no page carries, so ANY resolution is over-firing. The fingerprint is
  // built by the shipped `computeFingerprint`, so it is a well-formed value that simply has no match.
  const role = 'button';
  const name = 'wg-absent-control-target';
  out.push({
    ...base,
    kind: 'absent',
    recordedRef: 'e-wg-absent-control-ref',
    step: {
      ...base.step,
      target: { ...t, role, name, attrs: {}, fingerprint: computeFingerprint({ role, name, attrs: {} }) },
    },
  });

  // (2) AMBIGUOUS — an identity that ≥2 elements on the ORIGINAL page share. `heal` short-circuits to
  // `low` at tier 1 whenever a fingerprint has ≥2 matches, so refuse is correct regardless of what the
  // deeper tiers would have said; and since the §3.4 mutations preserve fingerprints, a collision on
  // the original is still a collision on the variant. The oracle is the collision COUNT on the
  // un-mutated page — it never consults the resolver it is scoring.
  const byFingerprint = new Map<string, HealCandidate[]>();
  for (const c of original.candidates) {
    const list = byFingerprint.get(c.target.fingerprint) ?? [];
    list.push(c);
    byFingerprint.set(c.target.fingerprint, list);
  }
  const collided = [...byFingerprint.values()].find((l) => l.length >= 2);
  if (collided) {
    const first = collided[0];
    out.push({
      ...base,
      kind: 'ambiguous',
      // The ref the recorder WOULD have minted for it: positionally tiebroken, hence unstable.
      recordedRef: first.ref,
      step: {
        ...base.step,
        target: {
          role: first.target.role, name: first.target.name, fingerprint: first.target.fingerprint,
          ancestorPath: first.target.ancestorPath,
          attrs: Object.fromEntries(
            STABLE_ATTRS.filter((k) => first.target.attrs[k] != null).map((k) => [k, first.target.attrs[k]]),
          ),
        },
      },
    });
  }
  return out;
}

export function runFlowDrift(): FlowDriftReport {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.html')).sort();
  const db = migratedDb();
  const report: FlowDriftReport = {
    fixtures: files.length, fixturesWithSeeds: 0, seeds: 0, cases: 0,
    a: emptyTally(), b: emptyTally(), aOnly: 0, bOnly: 0,
    tierTransitions: {}, perMutation: {}, mutationPreservesRawElements: true, harnessViewDelta: {},
    seedsWithoutStableAttrs: 0,
    mustRefuse: { cases: 0, aFired: 0, bFired: 0, absentCases: 0, absentAFired: 0, ambiguousCases: 0, ambiguousAFired: 0 },
  };
  for (const m of MUTATION_CLASSES) report.perMutation[m] = { cases: 0, a: 0, b: 0, bOnly: 0, wrongA: 0, wrongB: 0 };

  for (const file of files) {
    const fixture = file.replace(/\.html$/, '');
    const html = readFileSync(join(FIXTURE_DIR, file), 'utf-8');
    const original = pageView(html);
    const seeds = storeSeeds(db, fixture, original);
    if (!seeds.length) continue;
    report.fixturesWithSeeds += 1;
    report.seeds += seeds.length;
    for (const s of seeds) {
      const attrs = s.step.target?.attrs ?? {};
      if (!STABLE_ATTRS.some((k) => attrs[k] != null && attrs[k] !== '')) report.seedsWithoutStableAttrs += 1;
    }

    for (const mutation of MUTATION_CLASSES) {
      const mutatedHtml = mutate(html, mutation as MutationClass, 1);
      const view = pageView(mutatedHtml);
      if (rawInteractiveCount(mutatedHtml) < rawInteractiveCount(html)) report.mutationPreservesRawElements = false;
      report.harnessViewDelta[mutation] = (report.harnessViewDelta[mutation] ?? 0) + (view.interactiveCount - original.interactiveCount);
      const per = report.perMutation[mutation];

      for (const seed of seeds) {
        report.cases += 1;
        per.cases += 1;
        report.a.cases += 1;
        report.b.cases += 1;
        const recordedRole = seed.step.target?.role;

        const a = armA(seed, view);
        const b = armB(seed, view);
        if (a.resolved) {
          report.a.resolved += 1; per.a += 1;
          if (a.role !== recordedRole) { report.a.wrong += 1; per.wrongA += 1; }
        } else bump(report.a.refusalsByReason, a.reason);
        if (b.resolved) {
          report.b.resolved += 1; per.b += 1;
          if (b.role !== recordedRole) { report.b.wrong += 1; per.wrongB += 1; }
        } else bump(report.b.refusalsByReason, b.reason);

        if (a.resolved && !b.resolved) report.aOnly += 1;
        if (b.resolved && !a.resolved) { report.bOnly += 1; per.bOnly += 1; }

        const observed = b.resolved ? b.confidence : (b as { reason: string }).reason === 'ambiguous_target' ? 'low' : 'none';
        bump(report.tierTransitions, `${seed.step.healTierAtRecord ?? 'unknown'}->${observed}`);
      }

      // The must-refuse control, on the same drifted page.
      for (const seed of mustRefuseSeeds(seeds[0], original)) {
        const aFired = armA(seed, view).resolved;
        report.mustRefuse.cases += 1;
        if (aFired) report.mustRefuse.aFired += 1;
        if (armB(seed, view).resolved) report.mustRefuse.bFired += 1;
        if (seed.kind === 'absent') {
          report.mustRefuse.absentCases += 1;
          if (aFired) report.mustRefuse.absentAFired += 1;
        } else {
          report.mustRefuse.ambiguousCases += 1;
          if (aFired) report.mustRefuse.ambiguousAFired += 1;
        }
      }
    }
  }
  db.close();
  return report;
}

/** G2's thresholds, as exact counts (spec §8). */
export const G2 = { minCases: 60, minArmBAdvantage: 8 } as const;

export function renderFlowDriftReport(r: FlowDriftReport): string {
  const rows = Object.entries(r.perMutation)
    .map(([k, v]) => `  ${k.padEnd(18)} cases=${String(v.cases).padStart(4)} A=${String(v.a).padStart(4)} B=${String(v.b).padStart(4)} B-only=${v.bOnly} wrongA=${v.wrongA} wrongB=${v.wrongB}`)
    .join('\n');
  const advantage = r.b.resolved - r.a.resolved;
  return [
    `G2 — two-arm drift benchmark (${r.cases} cases over ${r.seeds} seeds, ${r.fixturesWithSeeds}/${r.fixtures} fixtures)`,
    `  arm A (ref equality)      resolved ${r.a.resolved}/${r.a.cases}  wrong ${r.a.wrong}`,
    `  arm B (seed + heal 1-3)   resolved ${r.b.resolved}/${r.b.cases}  wrong ${r.b.wrong}`,
    `  arm B advantage           ${advantage}   (threshold >= ${G2.minArmBAdvantage} at ${G2.minCases} cases)`,
    `  B-only ${r.bOnly}   A-only ${r.aOnly} (expected 0 — same fingerprint key)`,
    `  must-refuse controls      ${r.mustRefuse.cases}  A fired ${r.mustRefuse.aFired}  B fired ${r.mustRefuse.bFired}`,
    `    of which ambiguous      ${r.mustRefuse.ambiguousCases}  A fired ${r.mustRefuse.ambiguousAFired}  <- the discriminating half`,
    `    of which absent         ${r.mustRefuse.absentCases}  A fired ${r.mustRefuse.absentAFired}`,
    `  seeds with no stable attr ${r.seedsWithoutStableAttrs}/${r.seeds}  (fingerprint == role+name for these)`,
    `  mutation removes no raw element (oracle premise): ${r.mutationPreservesRawElements}`,
    `  harness snapshot delta    ${JSON.stringify(r.harnessViewDelta)}  (negative = 400-child walk cap, not a deletion)`,
    `  tier transitions          ${JSON.stringify(r.tierTransitions)}`,
    rows,
  ].join('\n');
}
