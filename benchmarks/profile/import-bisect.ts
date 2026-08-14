#!/usr/bin/env node
/**
 * Bisects the cold-start module graph: how much of `import dist/server.js`
 * belongs to which dependency.
 *
 *   RUN_PROFILE=1 npx tsx benchmarks/profile/import-bisect.ts
 *
 * Each specifier is imported ALONE in a fresh process, so shared sub-graphs are
 * not double-counted into whichever import happened to run second. The numbers
 * therefore do not sum to the server-graph total — a dependency's isolated cost
 * includes sub-graphs it shares with others. That is stated rather than hidden.
 *
 * `baseline` is an empty import, i.e. Node runtime boot alone; every other row
 * is already baseline-subtracted.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stats } from './mcp-child.js';

if (!process.env.RUN_PROFILE) {
  process.stderr.write('[profile:imports] Skipped. Set RUN_PROFILE=1 to run.\n');
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DIST = pathToFileURL(join(ROOT, 'dist')).href;
const RUNS = Number(process.env.PROFILE_IMPORT_RUNS ?? 7);

const TARGETS: { name: string; spec: string | null }[] = [
  { name: 'baseline (no import)', spec: null },
  { name: 'dist/server.js (whole graph)', spec: `${DIST}/server.js` },
  { name: 'dist/index.js (CLI entry)', spec: `${DIST}/index.js` },
  { name: '  better-sqlite3', spec: 'better-sqlite3' },
  { name: '  sqlite-vec', spec: 'sqlite-vec' },
  { name: '  playwright', spec: 'playwright' },
  { name: '  @modelcontextprotocol/sdk (server)', spec: '@modelcontextprotocol/sdk/server/index.js' },
  { name: '  linkedom', spec: 'linkedom' },
  { name: '  defuddle/node', spec: 'defuddle/node' },
  { name: '  @mozilla/readability', spec: '@mozilla/readability' },
  { name: '  turndown', spec: 'turndown' },
  { name: '  sharp', spec: 'sharp' },
  { name: '  fastembed', spec: 'fastembed' },
  { name: '  @huggingface/transformers', spec: '@huggingface/transformers' },
  { name: '  onnxruntime-node', spec: 'onnxruntime-node' },
  { name: '  ink', spec: 'ink' },
  { name: '  react', spec: 'react' },
  { name: '  groq-sdk', spec: 'groq-sdk' },
  { name: '  openai', spec: 'openai' },
  { name: '  @anthropic-ai/sdk', spec: '@anthropic-ai/sdk' },
  { name: '  @google/genai', spec: '@google/genai' },
  { name: '  pdf-parse', spec: 'pdf-parse' },
  { name: '  ws', spec: 'ws' },
];

function runOnce(spec: string | null): Promise<{ ms: number; rss: number } | { error: string }> {
  const code = spec
    ? `const t=performance.now();await import(${JSON.stringify(spec)});process.stdout.write(JSON.stringify({ms:performance.now()-t,rss:process.memoryUsage.rss()}))`
    : `const t=performance.now();process.stdout.write(JSON.stringify({ms:performance.now()-t,rss:process.memoryUsage.rss()}))`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: ROOT,
      env: { ...process.env, WIGOLO_LOG_LEVEL: 'error' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('exit', () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve({ error: err.trim().split('\n').at(-1) ?? 'no output' });
      }
    });
  });
}

async function main(): Promise<void> {
  const rows: {
    name: string;
    n: number;
    min: number;
    median: number;
    max: number;
    rss_mb: number;
    error?: string;
  }[] = [];

  for (const t of TARGETS) {
    process.stderr.write(`[profile:imports] ${t.name}\n`);
    const ms: number[] = [];
    const rss: number[] = [];
    let error: string | undefined;
    for (let i = 0; i < RUNS; i++) {
      const r = await runOnce(t.spec);
      if ('error' in r) {
        error = r.error;
        break;
      }
      ms.push(r.ms);
      rss.push(r.rss / 1024 / 1024);
    }
    if (error) {
      rows.push({ name: t.name, n: 0, min: 0, median: 0, max: 0, rss_mb: 0, error });
      continue;
    }
    const s = stats(ms);
    rows.push({ name: t.name, ...s, rss_mb: stats(rss).median });
  }

  const outDir = join(__dirname, 'output');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'import-bisect.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), runs: RUNS, rows }, null, 2),
  );

  const lines = [
    `\n=== MODULE IMPORT COST (isolated, fresh process, n=${RUNS} each) ===`,
    `  ${'module'.padEnd(38)} ${'min'.padStart(8)} ${'median'.padStart(8)} ${'max'.padStart(8)} ${'rss MB'.padStart(8)}`,
  ];
  for (const r of rows) {
    if (r.error) {
      lines.push(`  ${r.name.padEnd(38)} ${'ERR'.padStart(8)}  ${r.error.slice(0, 60)}`);
      continue;
    }
    lines.push(
      `  ${r.name.padEnd(38)} ${r.min.toFixed(1).padStart(8)} ${r.median.toFixed(1).padStart(8)} ${r.max.toFixed(1).padStart(8)} ${r.rss_mb.toFixed(1).padStart(8)}`,
    );
  }
  lines.push(
    '  NOTE: rows are isolated imports and share sub-graphs, so they do not sum to the server-graph row.',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((err) => {
  process.stderr.write(`[profile:imports] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
