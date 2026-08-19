/**
 * S13-1 — the drift benchmark behind gate G2: *does healing actually beat what the audit already
 * permits?*
 *
 * THREE arms over IDENTICAL cases, each case being (a recorded flow step seed) × (one mutation of the
 * frozen C0 page it was recorded against):
 *
 *  - **arm A — ref equality only.** Recompute refs on the drifted page and match the recorded ref
 *    string. This is the resolver `studio_audit` alone supports, so it is the honest baseline: it is
 *    what S13 would ship if seeds bought nothing.
 *  - **arm H — the heal boundary**, tiers 1–3 on `heal`'s own confidence, no §5.3 halts. The reach the
 *    seed apparatus makes available.
 *  - **arm B — the shipped `resolveFlowStep`**, i.e. arm H plus the role check and §5.3's halts. The
 *    reach the product actually accepts.
 *
 * A and B alone are not enough to answer G2, and reporting only them is how the first version of this
 * harness went wrong: a 0 at arm B is produced either by heal finding nothing or by §5.3 declining what
 * heal found, and those are opposite findings with opposite remedies. `haltedFromH` separates them.
 *
 * All arms consume the SAME stored steps, round-tripped through the shipped flow store, so arm B is
 * measured on exactly the seed a replay would read — not on a richer in-memory target. And
 * `healTierAtRecord` is MEASURED on the original page rather than assumed: pinning it to `'high'`
 * silently makes `bOnly == 0` a theorem, because §5.3 halts on any tier below the recorded one.
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
import { heal, type HealCandidate } from '../../src/studio/mark/heal.js';
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

/**
 * The tier `heal` actually achieves for this element on its OWN un-drifted page — what a recorder
 * observes at record time, since a recording stores the verdict the live resolve produced.
 *
 * For a seed drawn from `recordableElements` this is `high` (the live resolver refuses an ambiguous
 * target, so every recordable element is uniquely fingerprinted). It is measured rather than written
 * down anyway, because the value is an INPUT to `resolveFlowStep`'s degradation halt: pinning it
 * decides the reach comparison instead of measuring it.
 */
function recordTier(el: HealCandidate, view: PageView): 'high' | 'medium' {
  return heal(el.target, view.candidates).confidence === 'high' ? 'high' : 'medium';
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
      recordedRef: el.ref,
      // MEASURED on the original page, never assumed. A hardcoded `'high'` here silently turns the
      // reach comparison into a theorem: `resolveFlowStep` halts whenever the observed rank is below
      // the recorded one, so a pinned `high` makes arm B accept tier 1 ONLY — which is precisely arm
      // A's set — and `bOnly == 0` then holds for every mutation rather than being an observation.
      healTierAtRecord: recordTier(el, view),
      ts: seq,
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
// The arms — THREE, because "what healing reaches" and "what the product accepts" are different
// numbers and collapsing them into one hides which of the two decided the comparison.
// ---------------------------------------------------------------------------

export type ArmOutcome =
  | { resolved: true; ref: string; role: string | undefined; confidence: string; degraded?: boolean }
  | { resolved: false; reason: string };

/**
 * The §11.A.6 transition label for one case: the tier at record → the tier **`heal` reported**.
 *
 * Extracted and exported so the blocker it fixes is testable. Derived from an arm-H outcome, never from
 * the resolver's refusal reason: a medium recovery surfaces at the resolver as `confidence_degraded`,
 * which is not an ambiguity, so a resolver-bucketed map folds it into `none` and can never contain
 * `high->medium` for ANY corpus. On the C0 pages both derivations happen to agree (everything resolves
 * at high), so only a case that actually degrades can tell them apart — hence `runDegradationProbe`.
 */
export function transitionLabel(tierAtRecord: string | undefined, healOutcome: ArmOutcome): string {
  return `${tierAtRecord ?? 'unknown'}->${healOutcome.resolved ? healOutcome.confidence : healOutcome.reason}`;
}

/** arm A: the recorded ref string, matched against the drifted page's refs. Nothing else. */
export function armA(seed: Seed, view: PageView): ArmOutcome {
  if (!view.refs.has(seed.recordedRef)) return { resolved: false, reason: 'ref_absent' };
  const hit = view.candidates.find((c) => c.ref === seed.recordedRef);
  return { resolved: true, ref: seed.recordedRef, role: hit?.target.role, confidence: 'exact' };
}

/**
 * arm H — the HEAL BOUNDARY: tiers 1–3, accepted on `heal`'s own confidence, with none of §5.3's
 * halts applied. This is the reach the seed apparatus makes available.
 *
 * Reported separately from arm B because §5.3's halt-on-worse-tier subtracts from it: a tier-2/3
 * recovery is a resolution `heal` found and the safety ruling then declines. Without this arm, that
 * subtraction is invisible and the reach row reads as "healing found nothing" when the truth may be
 * "healing found it and the product refused it".
 */
export function armH(seed: Seed, view: PageView): ArmOutcome {
  const t = seed.step.target;
  if (!t) return { resolved: false, reason: 'missing_seed' };
  const h = heal(t, view.candidates);
  if (h.confidence === 'low' || h.confidence === 'none' || !h.ref) {
    return { resolved: false, reason: h.confidence };
  }
  const hit = view.candidates.find((c) => c.ref === h.ref);
  return { resolved: true, ref: h.ref, role: hit?.target.role, confidence: h.confidence };
}

/**
 * arm B: the shipped resolver — seed → `heal` tiers 1–3 → ref, WITH §5.3's halts. The product.
 *
 * ⚠️ **Since A174 (2026-08-19) §5.3 has THREE halts, not four.** A weaker-than-recorded resolution now
 * resolves carrying a `degraded` marker instead of refusing, so `haltedFromH` no longer counts it while
 * `degradedResolutions` does. **Arm B therefore moved TOWARD arm H by exactly the old `haltedFromH`, which
 * this corpus measures at 0** — so the amendment's predicted effect on every C0 count is zero, and
 * `runDegradationProbe` is the one artifact that flips.
 */
export function armB(seed: Seed, view: PageView): ArmOutcome {
  const r = resolveFlowStep(seed.step, view.candidates);
  if (!r.ok) return { resolved: false, reason: r.reason };
  const hit = view.candidates.find((c) => c.ref === r.ref);
  return {
    resolved: true, ref: r.ref, role: hit?.target.role, confidence: r.confidence,
    ...(r.degraded ? { degraded: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ArmTally {
  cases: number;
  resolved: number;
  /**
   * Resolved a ref whose role differs from the recorded role. **Must-refuse over-firing is NOT
   * counted here** — it is tallied in `mustRefuse` against its own oracle. Stated explicitly because
   * an earlier version of this comment claimed both, and a reader would then quote `wrong` as though
   * it already included over-firing.
   */
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
  /** arm H — the heal boundary, before §5.3's halts. */
  h: ArmTally;
  /** Cases arm A resolves that arm B does not. Expected 0 — they key on the same fingerprint. */
  aOnly: number;
  /** Cases arm B resolves that arm A does not. This is the number G2's threshold is written on. */
  bOnly: number;
  /** Cases the HEAL BOUNDARY resolves that arm A does not — the reach the seed apparatus makes available. */
  hOnly: number;
  /**
   * Cases arm H resolves and arm B does not: resolutions `heal` found and §5.3's halt declined.
   * The cost of the safety ruling, stated as its own number so it is not read as healing's failure.
   *
   * ⚠️ **Since A174 this counts the THREE surviving halts only.** A degradation no longer lands here.
   */
  haltedFromH: number;
  /**
   * Cases arm B resolved **below the tier they were recorded at** (§5.3 as amended, A174).
   *
   * 🔑 **This number exists because the amendment turned a refusal into an acceptance.** Before A174 the
   * cost of the degradation rule was visible as `haltedFromH`; surfacing would otherwise have made that
   * cost vanish from the report rather than change category — and a risk we decided to accept is exactly
   * the risk that must stay countable. **`degradedResolutions + haltedFromH` is what the old
   * `haltedFromH` alone used to be**, which is the identity a reader can check the amendment against.
   */
  degradedResolutions: number;
  /**
   * `heal_tier_at_record` → the tier **`heal` itself reported**, e.g. `high->medium` (§11.A.6).
   *
   * Derived from `heal`'s confidence, NOT from the resolver's refusal reason. Bucketing the resolver's
   * reasons cannot express this distribution at all: a medium recovery raises `confidence_degraded`,
   * which is not an ambiguity, so it would land in the `none` bucket and `high->medium` could never
   * appear no matter how the corpus drifted.
   */
  tierTransitions: Record<string, number>;
  /** The resolver's own outcomes, kept apart from the heal-tier distribution above. */
  resolverOutcomes: Record<string, number>;
  perMutation: Record<string, { cases: number; a: number; b: number; h: number; bOnly: number; hOnly: number; wrongA: number; wrongB: number }>;
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
    /**
     * Of the cases arm A fired on, how many landed on the element the ref was minted for, and how
     * many on a DIFFERENT member of the identical-sibling run.
     *
     * The distinction is the whole claim. "Arm A fired" only means it resolved a target it could not
     * know was safe; `differentElement` is the count where it was observably wrong. A collided ref is
     * `hash(fingerprint|positionPath)`, so arm A fires exactly when the positional path is
     * byte-preserved — which is also when the ref still designates the same node. So a corpus of
     * position-preserving mutations produces `firedSameElement == aFired` and NO wrong element, and
     * reporting only `aFired` would overstate that as a wrong click.
     */
    firedSameElement: number;
    firedDifferentElement: number;
    /** Distinct (seed, collision-group) shapes behind the ambiguous cases — each replayed once per mutation. */
    ambiguousDistinctShapes: number;
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
/**
 * A content-derived identity for one element, independent of every locator under test: the a11y
 * identity plus `href`. Two members of an identical-fingerprint run share role+name by construction,
 * so `href` is what tells them apart — and it survives all five §3.4 mutations, none of which rewrites
 * it. This is how "did arm A land on the element its ref was minted for?" gets answered without
 * consulting a fingerprint, a ref, or `heal`.
 */
function identityOf(target: HealCandidate['target']): string {
  return `${target.role}|${target.name}|${target.attrs['href'] ?? ''}`;
}

type MustRefuseKind = 'absent' | 'ambiguous';

type MustRefuseSeed = Seed & {
  kind: MustRefuseKind;
  /** For an ambiguous case: the identity of the element the recorded ref was minted for. */
  identity?: string;
  /** For an ambiguous case: whether the run's members are distinguishable at all by content. */
  groupDistinguishable?: boolean;
};

function mustRefuseSeeds(base: Seed, original: PageView): MustRefuseSeed[] {
  const t = base.step.target;
  if (!t) return [];
  const out: MustRefuseSeed[] = [];

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
      identity: identityOf(first.target),
      // 20-odd of these groups are byte-identical on href+text, so "the other member" is not an
      // observably different outcome. Recorded so the row cannot be read as N wrong clicks.
      groupDistinguishable: new Set(collided.map((c) => identityOf(c.target))).size > 1,
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
    a: emptyTally(), b: emptyTally(), h: emptyTally(), aOnly: 0, bOnly: 0, hOnly: 0, haltedFromH: 0,
    degradedResolutions: 0,
    tierTransitions: {}, resolverOutcomes: {}, perMutation: {}, mutationPreservesRawElements: true, harnessViewDelta: {},
    seedsWithoutStableAttrs: 0,
    mustRefuse: {
      cases: 0, aFired: 0, bFired: 0, absentCases: 0, absentAFired: 0, ambiguousCases: 0,
      ambiguousAFired: 0, firedSameElement: 0, firedDifferentElement: 0, ambiguousDistinctShapes: 0,
    },
  };
  for (const m of MUTATION_CLASSES) report.perMutation[m] = { cases: 0, a: 0, b: 0, h: 0, bOnly: 0, hOnly: 0, wrongA: 0, wrongB: 0 };
  // Distinct ambiguous SHAPES, counted once per fixture rather than once per (fixture x mutation):
  // the same shape replayed under five mutations is five cases but one independent sample, and the
  // effective sample size is what a rate should be read against.
  const ambiguousShapes = new Set<string>();

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
        const hOut = armH(seed, view);
        report.h.cases += 1;
        if (a.resolved) {
          report.a.resolved += 1; per.a += 1;
          if (a.role !== recordedRole) { report.a.wrong += 1; per.wrongA += 1; }
        } else bump(report.a.refusalsByReason, a.reason);
        if (b.resolved) {
          report.b.resolved += 1; per.b += 1;
          // ⚠️ NOT MUTATION-COVERED, and measured rather than assumed: deleting this line reds NOTHING
          // (probe M6, 2026-08-19 — 0 reds, exit 0). No §3.4 class perturbs a stable attr, so the corpus
          // produces zero degradations and `degradedResolutions == 0` holds whether or not this counts.
          // The assertion on it is a must-not-fire control, NOT evidence the counter works. Reaching it
          // needs a mutation class that moves {type,name,placeholder} — S12 drift work, not this slice.
          // Recorded as K35.
          if (b.degraded) report.degradedResolutions += 1;
          if (b.role !== recordedRole) { report.b.wrong += 1; per.wrongB += 1; }
        } else bump(report.b.refusalsByReason, b.reason);
        if (hOut.resolved) {
          report.h.resolved += 1; per.h += 1;
        } else bump(report.h.refusalsByReason, hOut.reason);

        if (a.resolved && !b.resolved) report.aOnly += 1;
        if (b.resolved && !a.resolved) { report.bOnly += 1; per.bOnly += 1; }
        if (hOut.resolved && !a.resolved) { report.hOnly += 1; per.hOnly += 1; }
        // A resolution `heal` found and the §5.3 halt declined. Its own number: otherwise the safety
        // ruling's cost is silently attributed to healing having found nothing.
        if (hOut.resolved && !b.resolved) report.haltedFromH += 1;

        // The heal-tier transition (§11.A.6), taken from `heal`'s OWN confidence. Bucketing the
        // resolver's refusal reasons here would collapse `medium` into `none`, because a medium
        // recovery surfaces as `confidence_degraded` rather than as an ambiguity.
        bump(report.tierTransitions, transitionLabel(seed.step.healTierAtRecord, hOut));
        // A degraded acceptance gets its OWN key rather than folding into `resolved:medium`: after
        // A174 those two are different events (one held its recorded tier, one did not) and a shared
        // key would make the distribution unable to express the difference — the same defect
        // `transitionLabel` was extracted to fix.
        bump(
          report.resolverOutcomes,
          b.resolved ? (b.degraded ? `resolved:${b.confidence}:degraded` : `resolved:${b.confidence}`) : b.reason,
        );
      }

      // The must-refuse control, on the same drifted page.
      for (const seed of mustRefuseSeeds(seeds[0], original)) {
        if (seed.kind === 'ambiguous' && seed.identity) ambiguousShapes.add(`${fixture}|${seed.identity}`);
        const aOut = armA(seed, view);
        const aFired = aOut.resolved;
        report.mustRefuse.cases += 1;
        if (aFired) report.mustRefuse.aFired += 1;
        if (armB(seed, view).resolved) report.mustRefuse.bFired += 1;
        if (seed.kind === 'absent') {
          report.mustRefuse.absentCases += 1;
          if (aFired) report.mustRefuse.absentAFired += 1;
        } else {
          report.mustRefuse.ambiguousCases += 1;
          if (aFired) report.mustRefuse.ambiguousAFired += 1;
          if (aFired && seed.identity) {
            // Did it land on the element the ref was minted for? Answered on a content identity, not
            // on any locator under test.
            const landed = view.candidates.find((c) => c.ref === aOut.ref);
            const same = landed != null && identityOf(landed.target) === seed.identity;
            if (same) report.mustRefuse.firedSameElement += 1;
            else report.mustRefuse.firedDifferentElement += 1;
          }
        }
      }
    }
  }
  report.mustRefuse.ambiguousDistinctShapes = ambiguousShapes.size;
  db.close();
  return report;
}

// ---------------------------------------------------------------------------
// The wrong-element probe — the case the C0 corpus cannot produce
// ---------------------------------------------------------------------------

/**
 * Two links with the SAME accessible name in one `<tbody>`, differing only in `href`, under
 * `sibling_reorder`.
 *
 * Why this has to be constructed rather than drawn from C0: the five §3.4 mutations preserve
 * fingerprints, so on the frozen pages arm A fires only where the positional path is byte-preserved —
 * i.e. only where the ref still designates the same node. The corpus therefore CANNOT exhibit a wrong
 * element, and a must-refuse row measured on it alone reports "arm A resolved a target it could not
 * know was safe", not "arm A clicked the wrong thing". This probe supplies the missing case: reordering
 * the rows moves the positional path, the tiebroken ref now designates the OTHER row, and the two rows
 * are observably different because their `href`s are.
 *
 * Kept out of `fixtures/html/` on purpose — that directory is S12-0's frozen C0 corpus and adding to it
 * would silently change every C0 count.
 */
const WRONG_ELEMENT_HTML = `<html><body><main><table><tbody>
<tr><td><a href="/row-ONE">Open order</a></td></tr>
<tr><td><a href="/row-TWO">Open order</a></td></tr>
</tbody></table></main></body></html>`;

export interface WrongElementProbe {
  /** The two rows share role+name, so a fingerprint cannot tell them apart. */
  fingerprintCollides: boolean;
  armAResolved: boolean;
  /** The identity arm A landed on vs the one its ref was minted for. */
  armARecordedIdentity: string;
  armAResolvedIdentity: string;
  armALandedOnDifferentElement: boolean;
  armBResolved: boolean;
  armBReason: string;
  armBConfidence: string;
  armBCandidates: number;
}

export function runWrongElementProbe(): WrongElementProbe {
  const original = pageView(WRONG_ELEMENT_HTML);
  const drifted = pageView(mutate(WRONG_ELEMENT_HTML, 'sibling_reorder', 1));

  const rowOne = original.candidates.find((c) => c.target.attrs['href'] === '/row-ONE');
  const rowTwo = original.candidates.find((c) => c.target.attrs['href'] === '/row-TWO');
  if (!rowOne || !rowTwo) throw new Error('wrong-element probe: fixture did not yield both rows');

  const seed: Seed = {
    fixture: 'wrong-element-probe',
    recordedRef: rowOne.ref,
    step: {
      flowId: 'flw_probe', sessionId: 'probe', seq: 1, auditSeq: 1, action: 'click',
      pageUrl: 'https://example.invalid/orders',
      target: {
        role: rowOne.target.role, name: rowOne.target.name, fingerprint: rowOne.target.fingerprint,
        ancestorPath: rowOne.target.ancestorPath, attrs: {},
      },
      recordedRef: rowOne.ref,
      // The recorder could never have stored this step (the live resolver refuses an ambiguous
      // target), which is exactly why the risk belongs to arm A: ref equality has no ambiguity notion.
      healTierAtRecord: 'high', ts: 1,
    },
  };

  const a = armA(seed, drifted);
  const b = armB(seed, drifted);
  const landed = a.resolved ? drifted.candidates.find((c) => c.ref === a.ref) : undefined;
  const resolvedIdentity = landed ? identityOf(landed.target) : '';
  const bResult = resolveFlowStep(seed.step, drifted.candidates);

  return {
    fingerprintCollides: rowOne.target.fingerprint === rowTwo.target.fingerprint,
    armAResolved: a.resolved,
    armARecordedIdentity: identityOf(rowOne.target),
    armAResolvedIdentity: resolvedIdentity,
    armALandedOnDifferentElement: a.resolved && resolvedIdentity !== identityOf(rowOne.target),
    armBResolved: b.resolved,
    armBReason: b.resolved ? '' : b.reason,
    armBConfidence: bResult.ok ? bResult.confidence : (bResult.confidence ?? ''),
    armBCandidates: bResult.ok ? 0 : (bResult.candidates ?? 0),
  };
}

// ---------------------------------------------------------------------------
// The degradation probe — the case the corpus cannot produce, forced into existence
// ---------------------------------------------------------------------------

/**
 * A field whose accessible name is pinned by `aria-label` while its `name` attribute drifts.
 *
 * This is the ONLY drift shape that reaches heal tier 2: the fingerprint is role + name + the fixed
 * `{type,name,placeholder}` slice, so breaking it while keeping role+name intact requires moving one of
 * those three attributes and nothing else. A name or role change defeats tier 2 as well, because tier 2
 * keys on role+name.
 *
 * It exists because the C0 corpus reports `hOnly == 0` and `haltedFromH == 0`, which would leave the
 * arm-H/arm-B split unable to differ from each other on any input — the split would look like a
 * measurement while being incapable of producing a difference. This probe forces the difference.
 *
 * ⚠️ **Its VERDICT was inverted by A174 and its VALUE was not.** It was built to measure what §5.3's halt
 * subtracted from heal's reach; the halt is now a `degraded` marker, so it measures that the weaker
 * resolution is **accepted and labelled** instead. It remains **the only case in the whole harness that
 * exercises the degradation path at all**, so it is also the only place the amendment is observable —
 * which is why the amendment's blast radius is this probe and nothing else.
 */
const DEGRADATION_HTML = `<html><body><main><form>
<input type="text" name="q" aria-label="Search orders">
</form></main></body></html>`;

function driftStableAttr(html: string): string {
  return html.replace(/\bname="q"/g, 'name="query"');
}

export interface DegradationProbe {
  /** The drift moved the fingerprint... */
  fingerprintChanged: boolean;
  /** ...while leaving the a11y identity tier 2 keys on intact. */
  roleNameHeld: boolean;
  tierAtRecord: string;
  /** arm H: heal recovers, one tier weaker. */
  healConfidence: string;
  healResolved: boolean;
  /** arm A: the ref was a pure function of the fingerprint, so it is gone. */
  armAResolved: boolean;
  /** arm B: the product ACCEPTS the weaker resolution and marks it (§5.3 as amended, A174). */
  armBResolved: boolean;
  armBReason: string;
  /** The `degraded` marker arm B carried, as `from->to`. Empty when it resolved at full confidence. */
  armBDegraded: string;
  /** The §11.A.6 label this case contributes — the value a resolver-bucketed map could not produce. */
  transitionLabel: string;
}

export function runDegradationProbe(): DegradationProbe {
  const original = pageView(DEGRADATION_HTML);
  const drifted = pageView(driftStableAttr(DEGRADATION_HTML));
  const field = original.candidates.find((c) => c.target.attrs['name'] === 'q');
  const after = drifted.candidates.find((c) => c.target.attrs['name'] === 'query');
  if (!field || !after) throw new Error('degradation probe: fixture did not yield the field');

  const tierAtRecord = recordTier(field, original);
  const seed: Seed = {
    fixture: 'degradation-probe',
    recordedRef: field.ref,
    step: {
      flowId: 'flw_deg', sessionId: 'deg', seq: 1, auditSeq: 1, action: 'click',
      pageUrl: 'https://example.invalid/orders',
      target: {
        role: field.target.role, name: field.target.name, fingerprint: field.target.fingerprint,
        ancestorPath: field.target.ancestorPath,
        attrs: Object.fromEntries(STABLE_ATTRS.filter((k) => field.target.attrs[k] != null).map((k) => [k, field.target.attrs[k]])),
      },
      recordedRef: field.ref, healTierAtRecord: tierAtRecord, ts: 1,
    },
  };

  const h = armH(seed, drifted);
  const a = armA(seed, drifted);
  const b = armB(seed, drifted);
  // Read from the resolver directly rather than from `ArmOutcome`'s boolean: the probe's whole claim is
  // WHICH tiers it moved between, and a boolean cannot carry that.
  const resolution = resolveFlowStep(seed.step, drifted.candidates);
  const degraded = resolution.ok ? resolution.degraded : undefined;
  return {
    fingerprintChanged: field.target.fingerprint !== after.target.fingerprint,
    roleNameHeld: field.target.role === after.target.role && field.target.name === after.target.name,
    tierAtRecord,
    healConfidence: h.resolved ? h.confidence : h.reason,
    healResolved: h.resolved,
    armAResolved: a.resolved,
    armBResolved: b.resolved,
    armBReason: b.resolved ? '' : b.reason,
    armBDegraded: degraded ? `${degraded.from}->${degraded.to}` : '',
    transitionLabel: transitionLabel(tierAtRecord, h),
  };
}

/** G2's thresholds, as exact counts (spec §8). */
export const G2 = { minCases: 60, minArmBAdvantage: 8 } as const;

export function renderFlowDriftReport(r: FlowDriftReport): string {
  const rows = Object.entries(r.perMutation)
    .map(([k, v]) => `  ${k.padEnd(18)} cases=${String(v.cases).padStart(4)} A=${String(v.a).padStart(4)} H=${String(v.h).padStart(4)} B=${String(v.b).padStart(4)} H-only=${v.hOnly} B-only=${v.bOnly} wrongA=${v.wrongA} wrongB=${v.wrongB}`)
    .join('\n');
  const mr = r.mustRefuse;
  return [
    `G2 — drift benchmark (${r.cases} cases over ${r.seeds} seeds, ${r.fixturesWithSeeds}/${r.fixtures} fixtures)`,
    `  arm A  ref equality only        resolved ${r.a.resolved}/${r.a.cases}  wrong-role ${r.a.wrong}`,
    `  arm H  heal boundary (1-3)      resolved ${r.h.resolved}/${r.h.cases}   <- reach the seeds make available`,
    `  arm B  shipped resolver         resolved ${r.b.resolved}/${r.b.cases}  wrong-role ${r.b.wrong}   <- reach the product accepts`,
    ``,
    `  REACH  H-A ${r.h.resolved - r.a.resolved}   B-A ${r.b.resolved - r.a.resolved}   (G2 threshold >= ${G2.minArmBAdvantage} at ${G2.minCases} cases)`,
    `  H-only ${r.hOnly}   B-only ${r.bOnly}   A-only ${r.aOnly}`,
    `  halted by §5.3's THREE surviving halts after heal succeeded: ${r.haltedFromH}`,
    `  resolved BELOW the recorded tier, surfaced not halted (A174): ${r.degradedResolutions}`,
    ``,
    `  must-refuse controls            ${mr.cases}  A fired ${mr.aFired}  B fired ${mr.bFired}`,
    `    ambiguous                     ${mr.ambiguousCases}  A fired ${mr.ambiguousAFired}  (${mr.ambiguousDistinctShapes} distinct shapes)`,
    `      of A's firings: same element ${mr.firedSameElement}   DIFFERENT element ${mr.firedDifferentElement}`,
    `    absent                        ${mr.absentCases}  A fired ${mr.absentAFired}`,
    ``,
    `  seeds with no stable attr       ${r.seedsWithoutStableAttrs}/${r.seeds}  (fingerprint == role+name for these)`,
    `  mutation removes no raw element (oracle premise): ${r.mutationPreservesRawElements}`,
    `  harness snapshot delta          ${JSON.stringify(r.harnessViewDelta)}  (negative = 400-child walk cap, not a deletion)`,
    `  heal-tier transitions           ${JSON.stringify(r.tierTransitions)}`,
    `  resolver outcomes               ${JSON.stringify(r.resolverOutcomes)}`,
    rows,
  ].join('\n');
}
