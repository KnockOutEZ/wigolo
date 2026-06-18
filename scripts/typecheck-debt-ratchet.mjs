#!/usr/bin/env node
/*
 * Debt ratchet for the legacy tests/ type-check.
 *
 * The Studio safety surface is held at ZERO by tsconfig.test.json. The rest of
 * tests/ carries pre-existing strict-mode debt (mostly implicit-any in legacy
 * test callbacks) that is a separate hygiene cleanup. This ratchet freezes that
 * debt at a baseline and FAILS if it INCREASES — so a new loosely-typed or
 * dangling-reference test can't quietly add to the pile. Lower BASELINE whenever
 * the count drops to lock the improvement in.
 */
import { execSync } from 'node:child_process';

const BASELINE = 280;

let count = 0;
try {
  execSync('npx tsc -p tsconfig.tests-debt.json', { stdio: 'pipe' });
} catch (err) {
  const out = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
  count = (out.match(/error TS/g) ?? []).length;
}

if (count > BASELINE) {
  console.error(`FAIL: tests/ type-check debt rose to ${count} (baseline ${BASELINE}).`);
  console.error('A new test added type errors — type its callbacks/fakes, or fix a dangling reference to changed production API.');
  console.error('Run `npx tsc -p tsconfig.tests-debt.json` to see them.');
  process.exit(1);
}
if (count < BASELINE) {
  console.log(`tests/ type-check debt decreased to ${count} (baseline ${BASELINE}). Lower BASELINE in scripts/typecheck-debt-ratchet.mjs to lock it in.`);
} else {
  console.log(`tests/ type-check debt holds at baseline ${BASELINE}.`);
}
