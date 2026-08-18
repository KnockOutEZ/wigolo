import { defineConfig, configDefaults } from 'vitest/config';

// D17 — de-contend the ambient full-suite spawn tail. The bulk unit lane runs fully
// parallel (forks); the spawn-heavy integration + e2e lane runs SERIALLY in its own
// project, so the thousands of parallel unit tests (and their dummy-key retry churn)
// can no longer starve the browser/subprocess-spawning integration tests — and vice
// versa. Execution TOPOLOGY only: every test's includes/asserts are unchanged, and the
// union of the two project globs is exactly the previous `tests/**/*.test.{ts,tsx}` set
// (integration+e2e in the serial project, everything else in the parallel project — no
// overlap, no gap), so collected counts are preserved by construction.

const shared = {
  globals: true,
  environment: 'node' as const,
  setupFiles: ['./tests/setup.ts'],
  testTimeout: 20000,
  // Hooks get the SAME allowance as test bodies. Vitest's hookTimeout default is
  // 10s, so leaving it unset meant a suite that had explicitly declared 20s for
  // synchronous filesystem + SQLite work still capped its setup at 10s — an
  // asymmetry, not a decision. That asymmetry is the whole reason for this line and
  // is still worth closing.
  //
  // This is deliberately not the "raise a timeout until it goes green" move: the
  // hook does bounded SYNCHRONOUS work and measures nothing, so a longer ceiling
  // cannot mask a signal. Contrast the BotD parity gate, which measures frame
  // cadence — there a raised timeout would hide the very thing under test, which
  // is why that one gets root-caused instead.
  //
  // The hooks this note used to cite as the motivating case — a `beforeEach` running
  // mkdtempSync + a 14-migration applyMigrations once per test — no longer cost what
  // they did. applyMigrations wraps EACH migration in its own transaction, and a bare
  // `new Database(<file>)` runs journal_mode=delete + synchronous=FULL (production
  // uses WAL+NORMAL, src/cache/db.ts:185), so those hooks paid a journal
  // create+fsync+delete 15-16 times per test and timed out on Windows CI. They now
  // wrap the fixture in one outer transaction — 15-16 commits down to 1 — so this
  // ceiling is headroom, not a crutch. Do not raise it to accommodate a new hook:
  // count the hook's top-level commits first.
  hookTimeout: 20000,
};

export default defineConfig({
  test: {
    // Reap abandoned throwaway HOME trees once per invocation, in the main process
    // before any worker forks — see tests/global-setup.ts for the leak it closes and
    // for what it deliberately does not cover. Root level, not per-project: the scan
    // must happen ONCE per run, and a copy in each project would run it three times
    // and race itself.
    globalSetup: ['./tests/global-setup.ts'],
    // Coverage stays global (it spans both projects).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          // Everything EXCEPT integration + e2e. Default (parallel) pool.
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          exclude: [...configDefaults.exclude, 'tests/integration/**', 'tests/e2e/**'],
        },
      },
      {
        test: {
          // The studio_* wire contract's deterministic half (drift check + wire predicates). It runs
          // HERE, in the ordinary suite, because a drift check that only runs when someone remembers to
          // run it is not a drift check — a core-side schema edit has to red on the same command that
          // already gates every change. Its own setup is deliberately absent: the contract must not
          // depend on core's test bootstrap, or it stops being checkable from outside.
          name: 'contract',
          environment: 'node',
          globals: true,
          include: ['contracts/*/tests/**/*.test.ts'],
        },
      },
      {
        test: {
          ...shared,
          name: 'spawn-serial',
          // The spawn-heavy lane: one fork, no file parallelism.
          include: [
            'tests/integration/**/*.test.ts',
            'tests/integration/**/*.test.tsx',
            'tests/e2e/**/*.test.ts',
            'tests/e2e/**/*.test.tsx',
          ],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
        },
      },
    ],
  },
});
