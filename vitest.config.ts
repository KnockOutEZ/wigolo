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
  // asymmetry, not a decision. It surfaced on Windows CI as
  // `tests/unit/studio/capture/list-session-artifacts.test.ts` timing out in a
  // `beforeEach` that runs mkdtempSync + a 14-migration applyMigrations ONCE PER
  // TEST; the same work in the test body would have been allowed 20s.
  //
  // This is deliberately not the "raise a timeout until it goes green" move: the
  // hook does bounded SYNCHRONOUS work and measures nothing, so a longer ceiling
  // cannot mask a signal. Contrast the BotD parity gate, which measures frame
  // cadence — there a raised timeout would hide the very thing under test, which
  // is why that one gets root-caused instead.
  hookTimeout: 20000,
};

export default defineConfig({
  test: {
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
