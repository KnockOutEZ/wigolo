import { defineConfig, configDefaults } from 'vitest/config';

// D17 — de-contend the ambient full-suite spawn tail. The bulk unit lane runs fully
// parallel (forks); the spawn-heavy integration + e2e lane runs SERIALLY in its own
// project, so the thousands of parallel unit tests (and their dummy-key retry churn)
// can no longer starve the browser/subprocess-spawning integration tests — and vice
// versa. Execution TOPOLOGY only: every test's includes/asserts are unchanged, and the
// union of the two project globs is exactly the previous `tests/**/*.test.{ts,tsx}` set
// (integration+e2e in the serial project, everything else in the parallel project — no
// overlap, no gap), so collected counts are preserved by construction.

/**
 * Parallel-lane test files that hand a `dist/` path to a child process — directly, or through a
 * fixture script they spawn. They are READERS of the artifact the serial lane REBUILDS, and the
 * two halves of that race have to sit in the same lane to take turns: `tests/unit/…` is otherwise
 * in the fully-parallel `unit` project, which vitest runs CONCURRENTLY with `spawn-serial`, so a
 * rebuild there deletes `dist/` (tsup `clean: true`) out from under a spawn that has just started.
 * Measured during the PX0 exit review (#176): `dist/daemon/studio-db-broker.js` was gone at t+436ms
 * and back at t+739ms across one `npm pack`-triggered build, and a spawn inside that window exits 1
 * with a module-not-found in a file that has nothing to do with the cause.
 *
 * They also belong here on the lane's own criterion — every one of them spawns a real process.
 *
 * This list is the lane split's single source of truth: `tests/unit/dist-rebuild-serialization.test.ts`
 * imports THIS file and derives lane membership from it, so a file added below is audited, and a
 * dist/-spawning file that is NOT below reds that guard.
 */
const DIST_SPAWNING_UNIT_TESTS = [
  // Probes every `wigolo/*` subpath export in a child Node process, so every one of them
  // resolves into `dist/` — the reader half of the same race.
  'tests/unit/package-exports.test.ts',
];

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
          // Everything EXCEPT integration + e2e, minus the dist/-spawning files that have to
          // take turns with the rebuilders. Default (parallel) pool.
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          exclude: [
            ...configDefaults.exclude,
            'tests/integration/**',
            'tests/e2e/**',
            ...DIST_SPAWNING_UNIT_TESTS,
          ],
        },
      },
      {
        test: {
          ...shared,
          name: 'spawn-serial',
          // The spawn-heavy lane: one fork, no file parallelism.
          //
          // DO NOT move a dist/-touching test back out of this lane. It is also the ONLY
          // lane in which rebuilding `dist/` is safe. tsup runs `clean: true`, so a rebuild
          // DELETES dist/ before writing it, while `tests/e2e/mcp-startup.test.ts` spawns
          // `dist/index.js` and `tests/integration/build-output.test.ts` asserts over dist/
          // files.
          // Serialised here they take turns; in the parallel `unit` project — which vitest
          // runs CONCURRENTLY with this one — a rebuild deletes dist/ under a test that has
          // just spawned it, and the red lands in an unrelated file with nothing pointing at
          // the cause. That shipped once: the G-TARBALL measurement sat in
          // tests/unit/budget-protocol.test.ts, and the `prepare` hook turned its
          // `npm pack --dry-run` into a full build. It now lives in
          // tests/integration/budget-tarball-gate.test.ts, and the rule is enforced by
          // tests/unit/dist-rebuild-serialization.test.ts rather than by memory.
          include: [
            'tests/integration/**/*.test.ts',
            'tests/integration/**/*.test.tsx',
            'tests/e2e/**/*.test.ts',
            'tests/e2e/**/*.test.tsx',
            // Readers, not rebuilders — see DIST_SPAWNING_UNIT_TESTS above. The lane guarded
            // rebuilders only, so these raced it from the parallel side.
            ...DIST_SPAWNING_UNIT_TESTS,
          ],
          pool: 'forks',
          // `poolOptions: { forks: { singleFork: true } }` used to sit here. Vitest 4 removed
          // `poolOptions` — the string `singleFork` does not appear anywhere in vitest 4.1.6 — so it
          // had become a line that reads like a guarantee and configures nothing, and the guard test
          // was asserting it as though it still bound. `maxWorkers: 1` is the supported way to say
          // the same thing, and it is asserted structurally now rather than by string match.
          maxWorkers: 1,
          fileParallelism: false,
        },
      },
    ],
  },
});
