/**
 * S12-0 — the corpus gate.
 *
 * A benchmark corpus has a RESOLUTION: with N assertions in a bucket, the finest verdict that
 * bucket can express is 1/N. A threshold finer than 1/N does not mean "a small tolerance", it
 * means ZERO, while reading like a tolerance to everyone downstream. This program has already
 * had three thresholds that were zero in disguise (spec §amendment 1), each caught only after
 * the number had been quoted in a review.
 *
 * So the corpus is not merely counted here, it is REPORTED WITH ITS ARITHMETIC: every bucket
 * prints N and 1/N, so nobody has to rediscover that a per-category tolerance below 0.033 was
 * unexpressible. This runs as its own lane and prints its numbers whether it passes or fails.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/logger.js';
import { REPLAY_ASSERTION_KINDS } from './types.js';
import type { Assertion, Category, ScrapeManifest } from './types.js';

const log = createLogger('extract');
const here = dirname(fileURLToPath(import.meta.url));

/**
 * §3.2 — the corpus targets. Every COUNT here is the spec's, not this file's.
 *
 * Two of the spec's four page classes are amended, each on a measurement rather than a
 * preference. Both amendments are recorded here and in the fixture manifest, because a class
 * that quietly changed meaning is worse than one that was never built.
 *
 * `chart_canvas` → `chart_hints`. Measured: ZERO chart `<canvas>` elements across 449/449 Web
 * Bench READ entry points and 40 deep permissively-licensed pages — and zero with the licence
 * filter dropped entirely. The binding constraint is the raw-HTML capture mechanism, not
 * licensing: charts are injected after load, so no frozen raw-HTML capture can contain one.
 *
 * The replacement is named for the product surface it scores: `extract mode:"structured"`
 * emits `chart_hints`, and the class asserts on those. It is NOT named `chart_svg`, because a
 * second measurement killed that name too — the permissive SVG-bearing pages (NASA 209/232
 * inline SVG, EPA 18/20, GitHub contributor graphs 73) yield 0, 0 and 1 hints respectively,
 * and the handful EPA does produce are UI icons: "Lock", "Primary navigation", "Open Sidenav
 * Menu". Those SVGs are icon sprites and chrome. A class named for SVG and populated by
 * fixtures carrying zero chart SVG would assert on "Lock" and pass without measuring anything.
 *
 * What actually carries chart semantics in frozen raw HTML is the FIGCAPTION limb of
 * `extractChartHints` (`src/extraction/structured.ts:125-137`), whose own comment says it
 * exists "for pages that render charts as images or canvas". Wikipedia renders every chart as
 * `<figure><img><figcaption>`, giving 18–39 genuine chart captions per page at CC BY-SA.
 *
 * NOTE THE CONSEQUENCE: this class's fixtures carry ZERO inline SVG. The figcaption limb is
 * the only one supplying them. That is why the class is not named for SVG — a class named for
 * a feature its fixtures do not contain is the same quiet meaning-drift this file exists to
 * prevent. Counts below were taken by running the REAL `extractStructured` over the captured
 * snapshots (39 / 24 / 18), not by reimplementing its selectors; the `min: 12` thresholds in
 * the manifest sit well under the measured values so a frozen snapshot keeps headroom.
 *
 * `virtualized_list` — REMOVED, not weakened. Neither lane runs site JS: the frozen lane never
 * had a browser, and the live lane serves fixture bytes from loopback with no third-party
 * origin. A virtualized-list fixture would render an empty container in BOTH lanes, so the
 * "measured ceiling" §3.2 asks for would be measuring the absence of a script rather than a
 * windowing ceiling. That is unreachable in a way no better fixture can fix. Deferred to
 * whichever slice lands a live-network lane; the ceiling stays stated prose until then.
 */
export const CORPUS_TARGETS = {
  fixtures: 20,
  assertions: 120,
  pageClasses: {
    visibility_divergent: 4,
    repeating_rows: 4,
    chart_hints: 3,
  } as Record<string, number>,
};

const CATEGORIES: Category[] = ['markdown_fidelity', 'table_preservation', 'boilerplate_noise', 'structured_extract'];

/**
 * K22 — §8-A's go/no-go thresholds, held as RATES and printed as COUNTS derived from the
 * corpus that is actually on disk.
 *
 * The spec states each gate twice: as an effect size ("≈ +0.15") and as the count that effect
 * size came to at an ASSUMED denominator ("≥ 5 more `table_preservation` assertions … at
 * ~30"). Only the first survives a corpus edit. The built corpus has 19 `table_preservation`
 * assertions, so the carried-forward "+5" is a 26% swing rather than the modest one the prose
 * implies — and on the 5-assertion corpus that preceded it, "+5" was arithmetically
 * unreachable, so the gate had never once been meetable as written.
 *
 * The fix is not a better number in prose. It is to stop quoting a count that was computed
 * against a denominator nobody re-measured: the RATE is the intent and lives here, the COUNT is
 * derived from the manifest at gate time and printed with its arithmetic. `specCount` and
 * `specAssumedN` are kept only so the restatement is auditable — they are never gated on.
 */
export const GO_NO_GO_A = [
  {
    gate: 'Overall',
    bucket: 'overall',
    rate: 0.05,
    specCount: 6,
    specAssumedN: 120,
    verdictBelow: 'NO-GO — a11y-first does not ship at all',
  },
  {
    gate: 'Table lane (sub-gate)',
    bucket: 'table_preservation',
    rate: 0.15,
    specCount: 5,
    specAssumedN: 30,
    verdictBelow: 'ships without the table lane',
  },
] as const;

export interface DerivedGate {
  gate: string;
  bucket: string;
  /** The spec's effect size. This, not the count, is the thing that carries forward. */
  intendedRate: number;
  /** Assertions measured in this bucket, right now, on this manifest. */
  n: number;
  /** Smallest count whose rate reaches `intendedRate` — the gate, restated. */
  count: number;
  /** What that count actually expresses. Never below `intendedRate`; often above it. */
  effectiveRate: number;
  /**
   * Whether the rate is expressible at all: a bucket of N can express nothing finer than 1/N,
   * so a rate below that resolution rounds up to a count that overshoots it badly. This is the
   * check that would have caught the 5-assertion corpus, where +0.15 could only be spelled as
   * +1 = +0.20.
   */
  expressible: boolean;
  /** The count the spec's prose carries, and the denominator it was computed against. */
  specCount: number;
  specAssumedN: number;
  /** What the spec's carried-forward count would MEAN against the measured denominator. */
  specCountRateHere: number;
  restated: boolean;
  verdictBelow: string;
}

export function deriveGoNoGoA(byBucket: Map<string, number>): DerivedGate[] {
  return GO_NO_GO_A.map((g) => {
    const n = byBucket.get(g.bucket) ?? 0;
    const count = n === 0 ? 0 : Math.ceil(g.rate * n);
    return {
      gate: g.gate,
      bucket: g.bucket,
      intendedRate: g.rate,
      n,
      count,
      effectiveRate: n === 0 ? Infinity : count / n,
      // n >= 1/rate is the same statement as "resolution is at least as fine as the rate".
      expressible: n > 0 && n >= 1 / g.rate,
      specCount: g.specCount,
      specAssumedN: g.specAssumedN,
      specCountRateHere: n === 0 ? Infinity : g.specCount / n,
      restated: count !== g.specCount,
      verdictBelow: g.verdictBelow,
    };
  });
}

/**
 * K24 — how much of the corpus is satisfied by an EMPTY extraction.
 *
 * K24 measured the ceiling on one kind: 30 of 101 assertions survived a `strip_body` probe,
 * every one an `absent` claim satisfied by an emptied document. `absent` now carries a source
 * precondition, but the shape generalises — a lower bound of zero, or an upper-bounded count
 * with no floor, is satisfied by an empty document too. So the balance is REPORTED, per
 * assertion kind, and a fixture author can see which way the corpus is drifting.
 *
 * Deliberately no threshold. Any ratio picked here would be a number nobody measured, which is
 * the failure this file exists to prevent. The count is guidance for whoever adds the next
 * fixture, not a gate.
 */
export function satisfiedByEmptyExtraction(a: Assertion): boolean {
  switch (a.kind) {
    // Needs the value to appear in the output — an empty document cannot satisfy it.
    case 'contains':
    case 'table_cell':
      return false;
    // Nothing to leak out of an empty document.
    case 'absent':
    case 'visible_only':
      return true;
    // A floor of zero cannot be violated by producing nothing.
    case 'count':
      return a.min <= 0;
    case 'structured':
      return a.min <= 0;
    // Replay kinds are never in the C0 manifest (enforced above) and are scored against a
    // replay outcome rather than an extraction, so the question does not arise.
    default:
      return false;
  }
}

export interface BucketResolution {
  bucket: string;
  n: number;
  /** The finest threshold this bucket can express. A gate below it means exactly zero. */
  resolution: number;
}

export interface CorpusVerdict {
  ok: boolean;
  fixtures: { actual: number; required: number; ok: boolean };
  assertions: { actual: number; required: number; ok: boolean };
  pageClasses: { pageClass: string; actual: number; required: number; ok: boolean }[];
  /** N and 1/N for the overall corpus and each of the four categories. */
  resolution: BucketResolution[];
  /** §8-A restated against the measured denominators (K22). */
  goNoGoA: DerivedGate[];
  /** K24 — assertions an empty extraction satisfies, per kind and in total. */
  emptySatisfiable: { total: number; assertions: number; byKind: Record<string, number> };
  /** Structural violations that are errors regardless of corpus size. */
  violations: string[];
}

export function validateCorpus(manifest: ScrapeManifest, htmlDir?: string): CorpusVerdict {
  const fixtures = manifest.fixtures;
  const allAssertions = fixtures.flatMap((f) => f.assertions);

  const byClass = new Map<string, number>();
  for (const f of fixtures) byClass.set(f.pageClass, (byClass.get(f.pageClass) ?? 0) + 1);

  const byCategory = new Map<Category, number>();
  for (const a of allAssertions) byCategory.set(a.category, (byCategory.get(a.category) ?? 0) + 1);

  const violations: string[] = [];

  // A replay assertion cannot be scored without a replay outcome, and the C0 lanes do not
  // produce one. Leaving one here would mean either a permanently-red blocking gate or a
  // scorer softened to pass it — and the second is how a referee stops refereeing.
  for (const f of fixtures) {
    for (const a of f.assertions) {
      if ((REPLAY_ASSERTION_KINDS as readonly string[]).includes(a.kind)) {
        violations.push(`${f.id}: '${a.kind}' is a replay assertion and belongs to the drift corpus, not the C0 manifest`);
      }
    }
  }

  // Non-vacuity, checked at corpus level so a dead `visible_only` value is caught by the gate
  // rather than sitting green in the report. Same rule the scorer applies per-run; enforced
  // here too because the gate is what a reviewer reads.
  if (htmlDir) {
    for (const f of fixtures) {
      const path = join(htmlDir, f.htmlPath);
      if (!existsSync(path)) continue;
      let html: string | undefined;
      for (const a of f.assertions) {
        if (a.kind !== 'visible_only') continue;
        html ??= readFileSync(path, 'utf-8');
        const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
        if (!flat.includes(a.value.replace(/\s+/g, ' ').toLowerCase())) {
          violations.push(`${f.id}: visible_only "${a.value}" is not present in ${f.htmlPath} — the assertion suppresses nothing`);
        }
      }
    }
  }

  const pageClasses = Object.entries(CORPUS_TARGETS.pageClasses).map(([pageClass, required]) => {
    const actual = byClass.get(pageClass) ?? 0;
    return { pageClass, actual, required, ok: actual >= required };
  });

  const resolution: BucketResolution[] = [
    { bucket: 'overall', n: allAssertions.length, resolution: allAssertions.length === 0 ? Infinity : 1 / allAssertions.length },
    ...CATEGORIES.map((c) => {
      const n = byCategory.get(c) ?? 0;
      return { bucket: c, n, resolution: n === 0 ? Infinity : 1 / n };
    }),
  ];

  const fx = { actual: fixtures.length, required: CORPUS_TARGETS.fixtures, ok: fixtures.length >= CORPUS_TARGETS.fixtures };
  const as = { actual: allAssertions.length, required: CORPUS_TARGETS.assertions, ok: allAssertions.length >= CORPUS_TARGETS.assertions };

  const byBucket = new Map<string, number>([['overall', allAssertions.length]]);
  for (const c of CATEGORIES) byBucket.set(c, byCategory.get(c) ?? 0);
  const goNoGoA = deriveGoNoGoA(byBucket);

  // An inexpressible go/no-go is a corpus defect, not a spec defect: the corpus is too small to
  // carry the verdict someone will read off it. Failing here is the only place it can be caught
  // BEFORE the number gets quoted in a review, which is how all three previous ones got through.
  for (const g of goNoGoA) {
    if (!g.expressible) {
      violations.push(`§8-A "${g.gate}" wants +${(g.intendedRate * 100).toFixed(0)}% of '${g.bucket}', but ${g.bucket} holds ${g.n} assertion(s): the finest step is 1/${g.n} and the rate is not expressible. Needs >= ${Math.ceil(1 / g.intendedRate)} assertions.`);
    }
  }

  const byKind: Record<string, number> = {};
  let emptySat = 0;
  for (const a of allAssertions) {
    if (!satisfiedByEmptyExtraction(a)) continue;
    emptySat += 1;
    byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  }

  return {
    ok: fx.ok && as.ok && pageClasses.every((p) => p.ok) && violations.length === 0,
    fixtures: fx,
    assertions: as,
    pageClasses,
    resolution,
    goNoGoA,
    emptySatisfiable: { total: emptySat, assertions: allAssertions.length, byKind },
    violations,
  };
}

export function renderCorpusVerdict(v: CorpusVerdict): string {
  const lines: string[] = ['# C0 corpus gate (S12-0 §3.2)', ''];
  const mark = (ok: boolean) => (ok ? '✅' : '❌');
  lines.push(`${mark(v.fixtures.ok)} fixtures ${v.fixtures.actual} / ${v.fixtures.required}`);
  lines.push(`${mark(v.assertions.ok)} assertions ${v.assertions.actual} / ${v.assertions.required}`);
  lines.push('', '## Required page classes', '', '| Class | Have | Need | |', '|---|---:|---:|---|');
  for (const p of v.pageClasses) lines.push(`| ${p.pageClass} | ${p.actual} | ${p.required} | ${mark(p.ok)} |`);

  lines.push('', '## Resolution arithmetic', '');
  lines.push('The finest threshold a bucket can express is 1/N. A gate below its bucket\'s');
  lines.push('resolution means EXACTLY ZERO, however it is worded.', '');
  lines.push('| Bucket | N | Resolution (1/N) | Finest meaningful threshold |', '|---|---:|---:|---|');
  for (const r of v.resolution) {
    const res = Number.isFinite(r.resolution) ? r.resolution.toFixed(4) : 'n/a (empty)';
    const note = r.n === 0 ? 'bucket is empty — no threshold is expressible' : `any gate below ${r.resolution.toFixed(4)} means zero`;
    lines.push(`| ${r.bucket} | ${r.n} | ${res} | ${note} |`);
  }

  lines.push('', '## §8-A go/no-go, restated against the measured corpus (K22)', '');
  lines.push('The spec states each gate as an effect size AND as the count that effect size came');
  lines.push('to at an assumed denominator. Only the effect size survives a corpus edit, so the');
  lines.push('count is re-derived here every run. Never quote the prose count.', '');
  lines.push('| Gate | Bucket | Intended | N | Restated gate | Actually expresses | Verdict below |', '|---|---|---:|---:|---|---:|---|');
  for (const g of v.goNoGoA) {
    const eff = Number.isFinite(g.effectiveRate) ? `+${(g.effectiveRate * 100).toFixed(1)}%` : 'n/a';
    lines.push(`| ${g.gate} | ${g.bucket} | +${(g.intendedRate * 100).toFixed(0)}% | ${g.n} | **+${g.count} assertions** | ${eff} | ${g.verdictBelow} |`);
  }
  lines.push('');
  for (const g of v.goNoGoA) {
    if (!g.restated) {
      lines.push(`- \`${g.bucket}\`: the spec's "+${g.specCount} at ~${g.specAssumedN}" survives the measurement — ${g.n} assertions gives the same +${g.count}.`);
      continue;
    }
    const was = Number.isFinite(g.specCountRateHere) ? `${(g.specCountRateHere * 100).toFixed(1)}%` : 'n/a';
    lines.push(`- ⚠️ \`${g.bucket}\`: the spec carries **+${g.specCount}**, computed against an assumed **${g.specAssumedN}**. Measured N is **${g.n}**, where +${g.specCount} would mean **${was}** rather than the intended +${(g.intendedRate * 100).toFixed(0)}%. **Restated: +${g.count}.**`);
  }

  lines.push('', '## Assertions an empty extraction satisfies (K24)', '');
  lines.push('An assertion satisfied by a document containing nothing is blind to total content');
  lines.push('loss. Reported, not gated — any ratio chosen here would be a number nobody measured.');
  lines.push('Steer new fixtures toward positive-content assertions when this share grows.', '');
  const es = v.emptySatisfiable;
  const share = es.assertions === 0 ? 'n/a' : `${((es.total / es.assertions) * 100).toFixed(1)}%`;
  lines.push(`${es.total} of ${es.assertions} assertions (${share}).`, '');
  lines.push('| Kind | Count |', '|---|---:|');
  for (const [k, n] of Object.entries(es.byKind).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${n} |`);
  if (Object.keys(es.byKind).length === 0) lines.push('| _none_ | 0 |');

  lines.push('', '## Structural violations', '');
  lines.push(v.violations.length ? v.violations.map((x) => `- ❌ ${x}`).join('\n') : '_none_');
  lines.push('', v.ok ? '✅ corpus gate PASSES' : '❌ corpus gate FAILS');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const manifestPath = join(here, 'fixtures', 'manifest.json');
  const htmlDir = join(here, 'fixtures', 'html');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ScrapeManifest;
  const verdict = validateCorpus(manifest, htmlDir);

  const outDir = join(here, 'output');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const rendered = renderCorpusVerdict(verdict);
  writeFileSync(join(outDir, 'corpus-gate.json'), `${JSON.stringify(verdict, null, 2)}\n`, 'utf-8');
  writeFileSync(join(outDir, 'corpus-gate.md'), rendered, 'utf-8');
  process.stderr.write(rendered);

  if (!verdict.ok) {
    log.error('corpus gate FAILED', { fixtures: verdict.fixtures.actual, assertions: verdict.assertions.actual });
    process.exitCode = 1;
  }
}

// Entry guard. The sibling `benchmarks/search/` runner omits exactly this, which is why it
// exits 0 having written nothing while a workflow reads a file it never produces.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    log.error('corpus gate crashed', { error: String(err) });
    process.exitCode = 1;
  });
}
