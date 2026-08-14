#!/usr/bin/env node
/**
 * Re-renders the profile table from a saved `output/profile.json`.
 *
 *   npx tsx benchmarks/profile/report.ts [path/to/profile.json]
 *
 * This exists so every headline figure is re-derivable from committed data
 * without re-running a network-dependent, host-specific suite. `runner.ts`
 * produces the JSON; this file is the only thing that turns it into the
 * numbers that get quoted.
 *
 * It prints three things the runner's inline table did not:
 *
 *  1. `overlap` — time when a socket was outstanding AND the cross-encoder was
 *     running. The partition credits ALL of it to rerank, which biases the
 *     network share down and the rerank share up. Same direction as the
 *     headline, so it is printed, not buried.
 *  2. `net_excl` — the network number actually reported (`net∪ − overlap`).
 *  3. The share rows sum to LESS than 100%: they are medians of per-call
 *     ratios, and medians of ratios are not additive. The shortfall is printed
 *     explicitly so nobody reads the rows as a partition of 100%.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stats, round } from './mcp-child.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATH = process.argv[2] ?? join(__dirname, 'output', 'profile.json');

interface Call {
  n: number;
  wall_ms: number;
  net_union_ms: number;
  net_exclusive_ms?: number;
  onnx_union_ms: number;
  bg_embed_union_ms: number;
  overlap_net_onnx_ms: number;
  remainder_ms: number;
  cpu_ms: number;
  mean_cores?: number;
  peak_rss_mb: number;
}

interface Session {
  tool: string;
  calls: Call[];
  idle_rss_mb: number;
  idle_ps_rss_mb?: number;
  peak_rss_mb: number;
  peak_ps_rss_mb?: number;
}

const report = JSON.parse(readFileSync(PATH, 'utf8')) as {
  generated_at: string;
  host: Record<string, unknown>;
  method: { warm_skip: number; cold_runs: number; warm_calls: number };
  cold: { idle_rss_mb: number; idle_ps_rss_mb?: number }[];
  cold_stats: Record<string, { n: number; min: number; median: number; max: number }>;
  warm_search: Session;
  warm_fetch: Session;
};

const SKIP = report.method.warm_skip;

function netExcl(c: Call): number {
  return c.net_exclusive_ms ?? c.net_union_ms - c.overlap_net_onnx_ms;
}

function session(s: Session): void {
  const warm = s.calls.filter((c) => c.n >= SKIP);
  console.log(`\n--- ${s.tool}: per-call series (N < ${SKIP} = warmup, excluded) ---`);
  console.log(
    `  ${'N'.padStart(3)} ${'wall'.padStart(8)} ${'net∪'.padStart(8)} ${'overlap'.padStart(8)} ${'netExcl'.padStart(8)} ${'rerank∪'.padStart(8)} ${'remain'.padStart(8)} ${'cores'.padStart(6)} ${'[bgEmb]'.padStart(8)}`,
  );
  for (const c of s.calls) {
    console.log(
      `  ${String(c.n).padStart(3)} ${c.wall_ms.toFixed(0).padStart(8)} ${c.net_union_ms.toFixed(0).padStart(8)} ${c.overlap_net_onnx_ms.toFixed(0).padStart(8)} ${netExcl(c).toFixed(0).padStart(8)} ${c.onnx_union_ms.toFixed(0).padStart(8)} ${c.remainder_ms.toFixed(0).padStart(8)} ${(c.mean_cores ?? 0).toFixed(1).padStart(6)} ${c.bg_embed_union_ms.toFixed(0).padStart(8)}${c.n < SKIP ? ' (warmup)' : ''}`,
    );
  }

  const w = stats(warm.map((c) => c.wall_ms));
  const shN = stats(warm.map((c) => (netExcl(c) / c.wall_ms) * 100));
  const shR = stats(warm.map((c) => (c.onnx_union_ms / c.wall_ms) * 100));
  const shRem = stats(warm.map((c) => (c.remainder_ms / c.wall_ms) * 100));
  const ov = stats(warm.map((c) => c.overlap_net_onnx_ms));
  const bg = stats(warm.map((c) => c.bg_embed_union_ms));

  console.log(`  warm N>=${SKIP} (n=${w.n})            min / median / max`);
  console.log(`    wall                 ${w.min} / ${w.median} / ${w.max} ms`);
  console.log(`    share%% network(excl) ${shN.min} / ${shN.median} / ${shN.max}`);
  console.log(`    share%% rerank        ${shR.min} / ${shR.median} / ${shR.max}`);
  console.log(`    share%% remainder     ${shRem.min} / ${shRem.median} / ${shRem.max}`);
  console.log(`    overlap credited to rerank ${ov.min} / ${ov.median} / ${ov.max} ms`);
  console.log(`    [bg embed, concurrent]     ${bg.min} / ${bg.median} / ${bg.max} ms`);

  const sum = shN.median + shR.median + shRem.median;
  console.log(
    `    !! share medians sum to ${round(sum)}%, NOT 100% — medians of per-call ratios are not additive.`,
  );
  console.log(
    `       ${round(100 - sum)}% of median wall (~${round(((100 - sum) / 100) * w.median)} ms) is unaccounted in these rows.`,
  );

  const spread = w.max - w.min;
  if (spread > w.median) {
    console.log(
      `    !! wall spread ${round(spread)} ms EXCEEDS median ${w.median} ms. With n=${w.n} over ${w.n} DIFFERENT inputs, this`,
    );
    console.log(
      '       is dominated by which input, not run-to-run noise. Quote the direction, not the point estimate.',
    );
  }

  console.log(
    `    RSS idle ${s.idle_rss_mb} MB (ps ${s.idle_ps_rss_mb ?? '—'}) -> peak ${s.peak_rss_mb} MB (ps ${s.peak_ps_rss_mb ?? '—'})`,
  );
}

console.log(`profile: ${PATH}`);
console.log(`generated: ${report.generated_at}`);
console.log(`host: ${JSON.stringify(report.host)}`);
console.log('\n=== A. COLD START ===');
for (const [k, v] of Object.entries(report.cold_stats)) {
  console.log(`  ${k.padEnd(28)} ${v.min} / ${v.median} / ${v.max}  (n=${v.n})`);
}
console.log('\n=== B. WARM BREAKDOWN ===');
session(report.warm_search);
session(report.warm_fetch);
console.log(
  '\nNOTE: `remainder := wall - union(net ∪ rerank)`, so netExcl + rerank + remainder = wall is an',
);
console.log(
  '      ALGEBRAIC IDENTITY. It cannot fail and is NOT independent validation of the instrument.',
);
