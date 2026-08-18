/**
 * S12-0 — the DRIFT corpus: the axis the C0 referee has no way to express today.
 *
 * Every C0 fixture is one frozen snapshot, so the referee can score "did extraction work on
 * this page" and nothing else. Heal quality — does a recorded selector still resolve after the
 * page changed, and does it REFUSE when it should — is the property a recipe lives or dies on
 * (§8-B), and it is invisible to a single-snapshot corpus.
 *
 * The drift corpus supplies the missing axis by MUTATING real frozen fixtures. That matters
 * beyond convenience: the variants are derived from producer output, so they carry the messy
 * structure real pages have. A corpus of hand-built literals would only ever contain the drift
 * shapes someone thought to imagine.
 *
 * S12-0 ships the ENGINE and the SCHEMA. Populating it needs recorded recipes, which need the
 * recipe format (S12-2) and the replay path (S12-4); §10 scopes S12-0 to the scaffold. The
 * validator below is therefore expected to report a shortfall, and says so in numbers rather
 * than leaving the gap to be discovered later.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/logger.js';
import type { Assertion, HealTier } from './types.js';

const log = createLogger('extract');
const here = dirname(fileURLToPath(import.meta.url));

/**
 * §3.4's five mutation classes, one per variant.
 *
 * Each is a distinct way a real page changes under a redesign, and each defeats a DIFFERENT
 * rung of the heal cascade (`src/studio/mark/heal.ts:39` — tier 1 fingerprint, tier 2
 * role+name, tier 3 ancestor-path spine). A corpus that only renamed classes would exercise
 * tier 1 and report the whole cascade as healthy.
 */
export const MUTATION_CLASSES = [
  'class_rename',
  'wrapper_div',
  'sibling_reorder',
  'attribute_churn',
  'section_rewrap',
] as const;
export type MutationClass = (typeof MUTATION_CLASSES)[number];

/**
 * What a variant is expected to do.
 *
 * `refuse` is as load-bearing as `resolve`, and the corpus validator enforces that both are
 * present: a corpus of only-must-resolve cases cannot catch OVER-FIRING, and over-firing is
 * precisely the silent-wrong failure §8-B's binding gate is built to detect.
 */
export type ExpectedVerdict =
  | { outcome: 'resolve'; atTier: 'high' | 'medium' }
  | { outcome: 'refuse' };

export interface DriftVariant {
  mutation: MutationClass;
  expected: ExpectedVerdict;
  /** Scored with the replay assertion kinds (`row_columns` / `row_count` / `heal_at_least`). */
  assertions: Assertion[];
}

export interface DriftRecipeCase {
  id: string;
  /** The C0 fixture whose frozen HTML this recipe was recorded against. */
  fixtureId: string;
  /** The column set recorded at authoring time. */
  columns: string[];
  /**
   * The heal tier the recipe resolved at when it was RECORDED. Recorded now because the
   * tier-at-record → tier-at-replay transition distribution is the only way §11 item 7
   * ("what should a replay do when it heals WORSE than authored?") gets answered with data
   * instead of argument. Costs nothing to record and cannot be reconstructed later.
   */
  healTierAtRecord: HealTier;
  variants: DriftVariant[];
}

export interface DriftManifest {
  version: string;
  note: string;
  recipes: DriftRecipeCase[];
}

/** §3.4 floors. 60 is derived from §8-B's resolution, not chosen for roundness. */
export const DRIFT_TARGETS = { recipes: 15, variantsPerRecipe: 4, cases: 60 };

// ---------------------------------------------------------------------------
// Mutation engine
// ---------------------------------------------------------------------------

/**
 * Apply one mutation class to a frozen document.
 *
 * Deliberately string-level rather than DOM-level: the frozen fixtures are megabyte-scale real
 * pages, the mutations are structural-but-local, and a full parse/serialize round-trip would
 * itself change the bytes in ways unrelated to the mutation under test — which would show up as
 * drift the recipe did not actually experience.
 */
export function mutate(html: string, mutation: MutationClass, seed = 1): string {
  switch (mutation) {
    case 'class_rename':
      // Defeats tier-1 fingerprints that lean on class names, leaves the spine intact.
      return html.replace(/\bclass="([^"]*)"/g, (_m, v: string) =>
        `class="${v.split(/\s+/).filter(Boolean).map((c) => `${c}-r${seed}`).join(' ')}"`,
      );

    case 'wrapper_div':
      // Inserts a level above the match root: the ancestor-path spine gets one longer, which
      // is what tier 3's normalized edit distance is supposed to absorb.
      return html.replace(/(<body\b[^>]*>)/i, `$1<div class="wg-drift-wrap-${seed}">`).replace(/(<\/body>)/i, `</div>$1`);

    case 'sibling_reorder': {
      // Reverses row order inside every <tbody>. Row identity survives; row POSITION does not,
      // which is what an index-based selector silently gets wrong.
      return html.replace(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi, (m, inner: string) => {
        const rows = inner.match(/<tr\b[\s\S]*?<\/tr>/gi);
        if (!rows || rows.length < 2) return m;
        const open = m.slice(0, m.indexOf('>') + 1);
        return `${open}${rows.reverse().join('')}</tbody>`;
      });
    }

    case 'attribute_churn':
      // Regenerated build-hash attributes — the single most common real-world drift, and the
      // one a naive attribute-equality fingerprint fails on every deploy.
      return html.replace(/\bdata-([a-z0-9-]+)="[^"]*"/gi, (_m, name: string) => `data-${name}="wg${seed}${Math.abs(hash(name + seed))}"`);

    case 'section_rewrap':
      // Semantic containers swapped for generic ones: the whole-section redesign. Defeats a
      // spine that leans on element names rather than shape.
      return html
        .replace(/<section\b/gi, '<div data-was="section"')
        .replace(/<\/section>/gi, '</div>')
        .replace(/<article\b/gi, '<div data-was="article"')
        .replace(/<\/article>/gi, '</div>')
        .replace(/<main\b/gi, '<div data-was="main"')
        .replace(/<\/main>/gi, '</div>');
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// ---------------------------------------------------------------------------
// Corpus validation
// ---------------------------------------------------------------------------

export interface DriftVerdict {
  ok: boolean;
  recipes: { actual: number; required: number; ok: boolean };
  cases: { actual: number; required: number; ok: boolean };
  /** Resolution of the case corpus: 1/N. §8-B's <=0.02 silent-wrong gate needs N >= 50. */
  caseResolution: number;
  /** Whether <=0.02 is expressible at this corpus size, and what it collapses to if not. */
  silentWrongExpressible: boolean;
  underVariedRecipes: string[];
  violations: string[];
}

export function validateDriftCorpus(manifest: DriftManifest): DriftVerdict {
  const violations: string[] = [];
  const underVaried: string[] = [];
  let cases = 0;

  for (const r of manifest.recipes) {
    cases += r.variants.length;
    if (r.variants.length < DRIFT_TARGETS.variantsPerRecipe) {
      underVaried.push(`${r.id}: ${r.variants.length} variant(s), need ${DRIFT_TARGETS.variantsPerRecipe}`);
    }
    const kinds = new Set(r.variants.map((v) => v.mutation));
    if (kinds.size !== r.variants.length) {
      violations.push(`${r.id}: mutation classes repeat within one recipe — §3.4 is one class per variant`);
    }
    if (r.columns.length === 0) violations.push(`${r.id}: no recorded column set`);
  }

  // The corpus must contain BOTH outcomes. An all-resolve corpus scores a resolver that never
  // refuses as perfect, and "never refuses" is the exact defect §8-B's binding gate exists for.
  const outcomes = new Set(manifest.recipes.flatMap((r) => r.variants.map((v) => v.expected.outcome)));
  if (manifest.recipes.length > 0) {
    if (!outcomes.has('refuse')) violations.push('corpus contains no must-REFUSE variant: it cannot detect over-firing');
    if (!outcomes.has('resolve')) violations.push('corpus contains no must-RESOLVE variant: it cannot detect under-firing');
  }

  const caseResolution = cases === 0 ? Infinity : 1 / cases;
  // §8-B: <=0.02 lands at exactly one case when N=60. Below ~50 it collapses to "exactly 0",
  // a stricter gate than intended, and the spec requires that be FLAGGED rather than absorbed.
  const silentWrongExpressible = cases >= 50;

  const rc = { actual: manifest.recipes.length, required: DRIFT_TARGETS.recipes, ok: manifest.recipes.length >= DRIFT_TARGETS.recipes };
  const cs = { actual: cases, required: DRIFT_TARGETS.cases, ok: cases >= DRIFT_TARGETS.cases };

  return {
    ok: rc.ok && cs.ok && underVaried.length === 0 && violations.length === 0,
    recipes: rc,
    cases: cs,
    caseResolution,
    silentWrongExpressible,
    underVariedRecipes: underVaried,
    violations,
  };
}

export function renderDriftVerdict(v: DriftVerdict): string {
  const mark = (ok: boolean) => (ok ? '✅' : '❌');
  const lines: string[] = ['# Drift corpus gate (S12-0 §3.4)', ''];
  lines.push(`${mark(v.recipes.ok)} recipes ${v.recipes.actual} / ${v.recipes.required}`);
  lines.push(`${mark(v.cases.ok)} replay cases ${v.cases.actual} / ${v.cases.required}`);
  lines.push('');
  lines.push('## Resolution arithmetic', '');
  if (Number.isFinite(v.caseResolution)) {
    lines.push(`Case corpus resolution: 1/${v.cases.actual} = ${v.caseResolution.toFixed(4)}.`);
  } else {
    lines.push('Case corpus is EMPTY — no rate threshold is expressible at all.');
  }
  lines.push(
    v.silentWrongExpressible
      ? `§8-B's silent-wrong gate (<=0.02) is expressible: it means "at most ${Math.floor(0.02 * v.cases.actual)} case(s)".`
      : `❌ §8-B's silent-wrong gate (<=0.02) is NOT expressible at ${v.cases.actual} case(s): it collapses to EXACTLY ZERO, a stricter gate than intended. Corpus must reach >=50 cases.`,
  );
  lines.push('', '## Under-varied recipes', '');
  lines.push(v.underVariedRecipes.length ? v.underVariedRecipes.map((x) => `- ${x}`).join('\n') : '_none_');
  lines.push('', '## Violations', '');
  lines.push(v.violations.length ? v.violations.map((x) => `- ❌ ${x}`).join('\n') : '_none_');
  lines.push('', v.ok ? '✅ drift corpus gate PASSES' : '❌ drift corpus gate FAILS (expected until S12-4 populates it)');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const manifestPath = join(here, 'fixtures', 'recipes', 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`drift manifest missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as DriftManifest;
  const verdict = validateDriftCorpus(manifest);

  const outDir = join(here, 'output');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const rendered = renderDriftVerdict(verdict);
  writeFileSync(join(outDir, 'drift-corpus.json'), `${JSON.stringify(verdict, null, 2)}\n`, 'utf-8');
  writeFileSync(join(outDir, 'drift-corpus.md'), rendered, 'utf-8');
  process.stderr.write(rendered);

  if (!verdict.ok) {
    log.error('drift corpus gate FAILED', { recipes: verdict.recipes.actual, cases: verdict.cases.actual });
    process.exitCode = 1;
  }
}

// Entry guard — see corpus-gate.ts.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    log.error('drift corpus gate crashed', { error: String(err) });
    process.exitCode = 1;
  });
}
