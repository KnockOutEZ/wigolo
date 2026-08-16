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

// 280 -> 412 on the 2026-08-02 `origin/main` merge (pre-flight #2). The +132 is INHERITED,
// not newly written: the merge imported ~130 test files that never existed on this branch
// (e.g. tests/unit/search/v1/v1-provider, tests/unit/fetch/router-challenge-status,
// router-clearance-route-gate), each carrying its own legacy implicit-any debt. Raising a
// one-way ratchet is otherwise wrong — it is justified here only because the corpus itself
// changed. The Studio safety surface stays at ZERO via tsconfig.test.json, which is the gate
// that actually protects the new code. Ratchet DOWN from 412 as the legacy debt is cleaned.
//
// 412 -> 399 on 2026-08-16. Earned, not estimated: the F3 slice found that
// tests/unit/search/hybrid/router.test.ts typed its fake as `ReturnType<typeof vi.fn>`, which
// erases the call signature to `(...args: any[]) => any` — so MockProvider never structurally
// satisfied SearchProvider and all 15 uses were already errors. Binding it to
// `MockedFunction<SearchProvider['search']>` cleared all 15. Locked only once every branch
// carrying the old errors had merged; a shared constant lowered while they are open fails them.
const BASELINE = 399;

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
