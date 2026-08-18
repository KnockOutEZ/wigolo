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
import type { Category, ScrapeManifest } from './types.js';

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

  return {
    ok: fx.ok && as.ok && pageClasses.every((p) => p.ok) && violations.length === 0,
    fixtures: fx,
    assertions: as,
    pageClasses,
    resolution,
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
