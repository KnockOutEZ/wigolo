#!/usr/bin/env node
/**
 * Cold-start attribution: which segment of "process start -> ready" dominates.
 *
 *   RUN_PROFILE=1 PROFILE_SCRATCH=/abs/scratch npx tsx benchmarks/profile/boot-breakdown.ts
 *
 * Each run is a fresh process with a fresh data dir (model caches cloned in, no
 * database), so nothing replays a warm path. Reported as min/median/max over
 * PROFILE_BOOT_RUNS runs — a single reading here moves by tens of ms between
 * runs and would be worthless on its own.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stats } from './mcp-child.js';

if (!process.env.RUN_PROFILE) {
  process.stderr.write('[profile:boot] Skipped. Set RUN_PROFILE=1 to run.\n');
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DIST_URL = pathToFileURL(join(ROOT, 'dist')).href;
const SCRATCH = process.env.PROFILE_SCRATCH;
if (!SCRATCH) throw new Error('PROFILE_SCRATCH must be an absolute scratch path');
const TEMPLATE = join(SCRATCH, 'wigolo-data-template');
if (!existsSync(join(TEMPLATE, 'fastembed'))) {
  throw new Error(`model-cache template missing at ${TEMPLATE}`);
}

const RUNS = Number(process.env.PROFILE_BOOT_RUNS ?? 7);

interface BootResult {
  total_ms: number;
  rss: number;
  marks: { name: string; ms: number }[];
}

function runOnce(i: number): Promise<BootResult> {
  const dir = join(SCRATCH!, `boot-data-${i}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(TEMPLATE, 'fastembed'), join(dir, 'fastembed'), { recursive: true });
  cpSync(join(TEMPLATE, 'transformers'), join(dir, 'transformers'), { recursive: true });

  return new Promise((resolve, reject) => {
    const spawnedAt = performance.timeOrigin + performance.now();
    const child = spawn(
      process.execPath,
      [join(__dirname, 'boot-probe.mjs'), String(spawnedAt), DIST_URL],
      {
        env: { ...process.env, WIGOLO_DATA_DIR: dir, WIGOLO_LOG_LEVEL: 'error' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('exit', (code) => {
      const line = out.trim().split('\n').filter(Boolean).at(-1);
      if (!line) {
        reject(new Error(`boot probe produced no output (code ${code}): ${err.slice(-2000)}`));
        return;
      }
      try {
        resolve(JSON.parse(line) as BootResult);
      } catch (e) {
        reject(new Error(`unparseable boot probe output: ${line.slice(0, 400)}`));
      }
    });
  });
}

async function main(): Promise<void> {
  const runs: BootResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    process.stderr.write(`[profile:boot] run ${i + 1}/${RUNS}\n`);
    runs.push(await runOnce(i));
  }

  const names = runs[0].marks.map((m) => m.name);
  const perStage = names.map((name) => {
    const vals = runs.map((r) => r.marks.find((m) => m.name === name)!.ms);
    return { name, ...stats(vals) };
  });
  const totals = stats(runs.map((r) => r.total_ms));
  const rss = stats(runs.map((r) => r.rss / 1024 / 1024));

  const outDir = join(__dirname, 'output');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'boot-breakdown.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), runs: RUNS, totals, rss_mb: rss, stages: perStage, raw: runs }, null, 2),
  );

  const lines: string[] = ['\n=== COLD-START ATTRIBUTION (fresh process + fresh data dir each run) ==='];
  lines.push(
    `  ${'stage'.padEnd(30)} ${'min'.padStart(8)} ${'median'.padStart(8)} ${'max'.padStart(8)} ${'% of median total'.padStart(18)}`,
  );
  for (const s of perStage) {
    lines.push(
      `  ${s.name.padEnd(30)} ${s.min.toFixed(1).padStart(8)} ${s.median.toFixed(1).padStart(8)} ${s.max.toFixed(1).padStart(8)} ${`${((s.median / totals.median) * 100).toFixed(1)}%`.padStart(18)}`,
    );
  }
  lines.push(`  ${'TOTAL'.padEnd(30)} ${totals.min.toFixed(1).padStart(8)} ${totals.median.toFixed(1).padStart(8)} ${totals.max.toFixed(1).padStart(8)}`);
  lines.push(`  RSS after full init: ${rss.min} / ${rss.median} / ${rss.max} MB (n=${RUNS})`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((err) => {
  process.stderr.write(`[profile:boot] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
