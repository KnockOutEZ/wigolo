/**
 * Over-fire probe for the `visible_only` arm (K25).
 *
 * The arm was relaxed from "the value must not appear in the markdown" to "the markdown
 * must not carry more copies than the visible source accounts for". A relaxation that
 * stops catching the real leak is worse than the bug it fixed, so the relaxation needs a
 * standing demonstration that it still fires — not a one-off run in a PR description.
 *
 * For every `visible_only` assertion in the corpus this scores the real extraction, then
 * re-scores it with ONE extra copy of the value spliced in. That extra copy is exactly
 * the leak the arm exists to catch: a copy the visible source cannot account for has
 * only one possible supplier, a hidden node. Every fixture must pass the first and fail
 * the second, and the probe exits non-zero if any does not.
 *
 * Run: `npx tsx benchmarks/scrape-quality/visible-only-probe.ts`
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/logger.js';
import { extractContent } from '../../src/extraction/pipeline.js';
import { evaluateAssertion } from './score.js';
import { loadManifest } from './runner.js';
import type { Assertion } from './types.js';
import type { StructuredData } from '../../src/types.js';

const log = createLogger('extract');
const here = dirname(fileURLToPath(import.meta.url));
const HTML_DIR = join(here, 'fixtures', 'html');

const EMPTY_STRUCTURED: StructuredData = {
  tables: [], definitions: [], jsonld: [], chart_hints: [], key_value_pairs: [],
};

type VisibleOnly = Extract<Assertion, { kind: 'visible_only' }>;

export interface ProbeRow {
  fixture: string;
  value: string;
  realPassed: boolean;
  realDetail?: string;
  injectedPassed: boolean;
  injectedDetail?: string;
  ok: boolean;
}

export async function probeVisibleOnly(): Promise<ProbeRow[]> {
  const manifest = loadManifest();
  const rows: ProbeRow[] = [];
  for (const f of manifest.fixtures) {
    for (const a of f.assertions) {
      if (a.kind !== 'visible_only') continue;
      const assertion = a as VisibleOnly;
      const html = readFileSync(join(HTML_DIR, f.htmlPath), 'utf-8');
      const { markdown } = await extractContent(html, f.url);
      const ctx = { sourceHtml: html };
      const real = evaluateAssertion(assertion, markdown, EMPTY_STRUCTURED, ctx);
      const injected = evaluateAssertion(
        assertion,
        `${markdown}\n\n${assertion.value}`,
        EMPTY_STRUCTURED,
        ctx,
      );
      rows.push({
        fixture: f.id,
        value: assertion.value,
        realPassed: real.passed,
        realDetail: real.detail,
        injectedPassed: injected.passed,
        injectedDetail: injected.detail,
        ok: real.passed && !injected.passed,
      });
    }
  }
  return rows;
}

export function renderProbe(rows: ProbeRow[]): string {
  const lines = [
    '# visible_only over-fire probe (K25)',
    '',
    'Each row: the real extraction must PASS, and the same markdown with one extra copy',
    'of the value — a copy the visible source cannot account for — must FAIL.',
    '',
    '| fixture | value | real | +1 injected copy | verdict |',
    '|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(
      `| \`${r.fixture}\` | ${r.value} | ${r.realPassed ? 'PASS' : `FAIL — ${r.realDetail ?? ''}`} ` +
      `| ${r.injectedPassed ? 'PASS (arm went blind)' : `FAIL — ${r.injectedDetail ?? ''}`} ` +
      `| ${r.ok ? '✅' : '❌'} |`,
    );
  }
  const bad = rows.filter((r) => !r.ok).length;
  lines.push('', bad === 0
    ? `✅ ${rows.length}/${rows.length} fixtures pass clean and still catch an injected copy`
    : `❌ ${bad} of ${rows.length} fixtures did not behave`);
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const rows = await probeVisibleOnly();
  // stderr, matching the runner: stdout stays free for piping.
  process.stderr.write(renderProbe(rows));
  const bad = rows.filter((r) => !r.ok);
  if (bad.length > 0) {
    log.error('visible_only over-fire probe FAILED', { fixtures: bad.map((r) => r.fixture) });
    process.exitCode = 1;
  }
  if (rows.length === 0) {
    // A probe that scores nothing must not read as a pass — that is the same blindness
    // in the harness that the vacuity rule guards against in the corpus.
    log.error('visible_only over-fire probe found nothing to score');
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    log.error('visible_only over-fire probe crashed', { error: String(err) });
    process.exitCode = 1;
  });
}
