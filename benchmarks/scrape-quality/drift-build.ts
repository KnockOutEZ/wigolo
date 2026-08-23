/**
 * K23 — build the drift corpus from the frozen C0 fixtures.
 *
 * §8-B's "≤0.02 silent-wrong" gate needs ≥50 replay cases before it means anything finer than
 * "exactly zero". The S12-0 scaffold shipped the mutation engine and the schema with an EMPTY
 * manifest, so the gate exited 1 and said so in numbers — correct, and useless as a measurement.
 *
 * This is the generator that populates it. Three properties are the point:
 *
 * 1. **Every recorded value is measured, never asserted.** The column set and row count come
 *    from running the real `extractStructured` over the real frozen bytes. Nothing here is a
 *    number somebody thought was about right — that is precisely how §8-A's "+5 at ~30" got
 *    into a spec against a corpus of 19.
 *
 * 2. **The expected verdict is measured too, per case, not assigned per mutation class.** It
 *    would be tidier to declare "`section_rewrap` defeats the spine, so expect refuse". It
 *    would also be wrong: a fixture whose table is not inside a `<section>` is untouched by that
 *    mutation, and the recipe would resolve against a corpus insisting it must not. So each
 *    variant is mutated and RE-MEASURED, and the verdict follows what survived.
 *
 * 3. **It is not scored by the thing it scores.** The expectation is derived from structured
 *    extraction over the mutated bytes — a different mechanism from the heal cascade the corpus
 *    exists to grade. A corpus whose expectations came from running the resolver would agree
 *    with the resolver by construction and grade nothing.
 *
 * Run: `npx tsx benchmarks/scrape-quality/drift-build.ts` (writes `fixtures/recipes/manifest.json`).
 * The output is committed, so `npm run bench:scrape:drift` never needs an extractor to run.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/logger.js';
import { extractStructured } from '../../src/extraction/structured.js';
import {
  mutate,
  validateDriftCorpus,
  DRIFT_TARGETS,
  MUTATION_CLASSES,
  type DriftManifest,
  type DriftRecipeCase,
  type DriftVariant,
  type MutationClass,
} from './drift.js';
import { loadManifest } from './runner.js';
import type { Assertion } from './types.js';

const log = createLogger('extract');
const here = dirname(fileURLToPath(import.meta.url));

/**
 * The recipe target: the biggest real table on the page.
 *
 * A recipe is recorded against a repeating-row region a human picked, and the closest thing a
 * frozen corpus has to that is the largest table structured extraction actually finds. The
 * floors (≥2 columns, ≥3 rows) exclude layout tables and two-row stubs, whose column identity
 * is too thin for a drift verdict to mean anything.
 */
const MIN_COLUMNS = 2;
const MIN_ROWS = 3;

interface Target {
  columns: string[];
  rowCount: number;
  firstRow: string;
}

function readTarget(html: string): Target | undefined {
  const tables = (extractStructured(html).tables ?? []).filter(
    (t) => (t.headers?.length ?? 0) >= MIN_COLUMNS && (t.rows?.length ?? 0) >= MIN_ROWS,
  );
  if (tables.length === 0) return undefined;
  tables.sort((a, b) => (b.rows?.length ?? 0) - (a.rows?.length ?? 0));
  const t = tables[0]!;
  return {
    columns: (t.headers ?? []).map(String),
    rowCount: t.rows?.length ?? 0,
    firstRow: JSON.stringify(t.rows?.[0] ?? null),
  };
}

/**
 * Which four of the five §3.4 mutation classes a given recipe carries.
 *
 * `sibling_reorder` is in every recipe because it is the only class that moves row IDENTITY
 * rather than the markup around it, so it is where the `medium` resolves and the refusals come
 * from on this corpus. Dropping it from a recipe would leave four variants that all resolve at
 * `high` — four cases that cost corpus size and measure one thing.
 *
 * The remaining three rotate through the other four classes by recipe index, so all five appear
 * across the corpus and no class is silently untested.
 */
export function variantClassesFor(index: number): MutationClass[] {
  const others = MUTATION_CLASSES.filter((m) => m !== 'sibling_reorder');
  const rotated = others.map((_, i) => others[(i + index) % others.length]!);
  return ['sibling_reorder', ...rotated.slice(0, DRIFT_TARGETS.variantsPerRecipe - 1)];
}

function buildVariant(html: string, recorded: Target, mutation: MutationClass): DriftVariant {
  const after = readTarget(mutate(html, mutation, 1));

  const sameColumns =
    after !== undefined &&
    after.columns.length === recorded.columns.length &&
    after.columns.every((c, i) => c === recorded.columns[i]);

  if (!sameColumns) {
    // The recorded column identity is gone. A replay that returns rows anyway is over-firing,
    // and over-firing is the silent-wrong failure §8-B's binding gate exists to detect — so the
    // case carries no row assertions. Its whole claim is the refusal, scored by the replay
    // harness against `expected.outcome`, not by `evaluateAssertion` against an output.
    return {
      mutation,
      expected: { outcome: 'refuse' },
      assertions: [],
      provenance: after === undefined
        ? 'measured: the recorded table is not recoverable from the mutated document at all'
        : `measured: column set changed to [${after.columns.join(', ')}]`,
    };
  }

  // Columns survive. Row IDENTITY is the remaining question: if the first row is no longer the
  // row that was recorded first, a positional anchor now points at different data while still
  // looking healthy, which is exactly the degradation §11 item 7 asks to be recorded rather
  // than argued about. Such a replay may still serve rows, but not at full confidence.
  const identityHeld = after.firstRow === recorded.firstRow;
  const atTier = identityHeld ? 'high' : 'medium';

  const assertions: Assertion[] = [
    {
      kind: 'row_columns',
      category: 'table_preservation',
      expect: recorded.columns,
      why: `Recorded column set must survive ${mutation}. Measured on the mutated document, not assumed from the mutation class.`,
    },
    {
      kind: 'row_count',
      category: 'table_preservation',
      min: after.rowCount,
      max: after.rowCount,
      why: `${after.rowCount} rows recoverable after ${mutation} (${recorded.rowCount} at record). Pinned exactly: a replay that returns a DIFFERENT number of rows has resolved to a different region, which a range would hide.`,
    },
    {
      kind: 'heal_at_least',
      category: 'table_preservation',
      tier: atTier,
      why: identityHeld
        ? `${mutation} leaves row identity intact, so a full-confidence resolve is the correct outcome.`
        : `${mutation} preserves the column set but moves row identity — the recorded first row is no longer first. A resolve is right; full confidence is not.`,
    },
  ];

  return {
    mutation,
    expected: { outcome: 'resolve', atTier },
    assertions,
    provenance: `measured: ${after.rowCount} rows, first-row identity ${identityHeld ? 'held' : 'MOVED'}`,
  };
}

export function buildDriftManifest(opts: { manifestPath?: string; htmlDir?: string } = {}): DriftManifest {
  const c0 = loadManifest(opts.manifestPath);
  const htmlDir = opts.htmlDir ?? join(here, 'fixtures', 'html');

  const recipes: DriftRecipeCase[] = [];
  const skipped: string[] = [];

  for (const f of c0.fixtures) {
    if (recipes.length >= DRIFT_TARGETS.recipes) break;
    const html = readFileSync(join(htmlDir, f.htmlPath), 'utf-8');
    const recorded = readTarget(html);
    if (!recorded) {
      skipped.push(`${f.id}: no table with >=${MIN_COLUMNS} columns and >=${MIN_ROWS} rows`);
      continue;
    }
    recipes.push({
      id: `recipe-${f.id}`,
      fixtureId: f.id,
      columns: recorded.columns,
      // Recorded against the UNMUTATED document the recipe was authored on, where the tier-1
      // fingerprint matches exactly. Anything lower here would be describing a different act of
      // recording than the one that happened.
      healTierAtRecord: 'high',
      variants: variantClassesFor(recipes.length).map((m) => buildVariant(html, recorded, m)),
    });
  }

  const cases = recipes.reduce((n, r) => n + r.variants.length, 0);
  const outcomes = new Set(recipes.flatMap((r) => r.variants.map((v) => v.expected.outcome)));

  // Fail the BUILD, not just the gate. A corpus that generated cleanly and happens to contain
  // no must-refuse case would pass every structural check while being unable to detect
  // over-firing — the one failure §8-B is built for. Better to never write that file.
  if (!outcomes.has('refuse')) {
    throw new Error('built corpus contains no must-REFUSE case: no mutation on these fixtures destroyed a recorded column set, so the corpus cannot detect over-firing');
  }
  if (!outcomes.has('resolve')) {
    throw new Error('built corpus contains no must-RESOLVE case: it cannot detect under-firing');
  }

  const byOutcome = recipes.flatMap((r) => r.variants).reduce<Record<string, number>>((acc, v) => {
    const k = v.expected.outcome === 'resolve' ? `resolve:${v.expected.atTier}` : 'refuse';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  return {
    version: '2.0.0',
    note: [
      'S12-4 drift corpus, BUILT by benchmarks/scrape-quality/drift-build.ts from the frozen C0 fixtures — do not hand-edit; re-run the builder.',
      `${recipes.length} recipes x ${DRIFT_TARGETS.variantsPerRecipe} variants = ${cases} replay cases, so §8-B's <=0.02 silent-wrong gate resolves to "at most ${Math.floor(0.02 * cases)} case(s)" instead of collapsing to exactly zero.`,
      'Every recorded value is MEASURED: columns and row counts come from running the real extractStructured over the real bytes, before and after each mutation. The expected verdict is measured per case rather than assigned per mutation class, because a mutation only drifts a recipe whose region it actually touches.',
      `Outcome distribution: ${JSON.stringify(byOutcome)}.`,
      skipped.length ? `Fixtures skipped for want of a recordable table: ${skipped.join('; ')}.` : 'No fixtures skipped.',
    ].join(' '),
    recipes,
  };
}

async function main(): Promise<void> {
  const manifest = buildDriftManifest();
  const out = join(here, 'fixtures', 'recipes', 'manifest.json');
  const verdict = validateDriftCorpus(manifest);

  if (!verdict.ok) {
    // Refuse to overwrite a good corpus with a bad one. The builder writing an invalid manifest
    // and leaving the gate to complain about it would put the corpus and its validator one
    // command out of step, which is how a red gate becomes something people run with.
    log.error('built corpus does not pass its own gate — NOT written', {
      recipes: verdict.recipes.actual,
      cases: verdict.cases.actual,
      violations: verdict.violations.length,
    });
    process.exitCode = 1;
    return;
  }

  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  log.info('drift corpus written', {
    recipes: verdict.recipes.actual,
    cases: verdict.cases.actual,
    silentWrongExpressible: verdict.silentWrongExpressible,
    refuseCases: verdict.outcomes.refuse,
  });
}

// Entry guard — see corpus-gate.ts.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    log.error('drift corpus build crashed', { error: String(err) });
    process.exitCode = 1;
  });
}
