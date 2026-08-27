import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

/*
 * WHY THIS LIVES IN `tests/integration/` AND NOT NEXT TO THE REST OF THE BUDGET PROTOCOL TESTS.
 *
 * It rebuilds `dist/`. `measure.mjs tarball` shells `npm pack --dry-run`, npm runs the packed
 * project's own `prepare` hook (even under `--dry-run`, even under `--ignore-scripts`), and
 * `prepare` builds — and tsup's `clean: true` DELETES `dist/` before it writes anything.
 *
 * `tests/integration/**` and `tests/e2e/**` are the `spawn-serial` vitest project: one fork,
 * `fileParallelism: false`. That is the only place a dist/-rebuilding test is safe, because it
 * is where the other dist/ readers already live — `tests/e2e/mcp-startup.test.ts` spawns
 * `dist/index.js`, `tests/integration/build-output.test.ts` asserts over dist/ files, and
 * `tests/integration/studio-runs-proxy.test.ts` imports from dist/ in a child. Serialised, they
 * take turns. Left in the parallel `unit` project, as this was, the full suite could delete
 * `dist/` out from under a test that had just spawned it: intermittent red, in a different
 * file, with a cause nothing points at — the shape of failure that gets retried away.
 *
 * The rule this file is an instance of is asserted, not just described, in
 * `tests/unit/dist-rebuild-serialization.test.ts`.
 */

describe('G-TARBALL survives the `prepare` lifecycle hook', () => {
  it('produces a parsed measurement rather than choking on build output', async () => {
    // WHY THIS ONE GATE IS RUN FOR REAL. The budget-protocol suite is right that measure.mjs
    // mostly cannot be tested — but that reason ("spawns servers and installs packages") does
    // not apply to `tarball`, which shells `npm pack --dry-run` and parses JSON off stdout. And
    // it is exactly the gate that broke: adding a `prepare` script made `npm pack` build first,
    // on the same stream, and JSON.parse died on the builder's progress lines. A source-shape
    // assertion would have agreed with whatever the source said; running it is the only check
    // that could have caught this. Reds if any future lifecycle hook writes to that stream too.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const script = fileURLToPath(new URL('../../scripts/budget/measure.mjs', import.meta.url));
    const { stdout } = await run(process.execPath, [script, 'tarball'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
    });
    expect(stdout).toMatch(/G-TARBALL/);
    expect(stdout).toMatch(/measured:\s+[\d.]+ MiB/);
    // `NaN MiB` is what an unparsed/partial read produces, and it would satisfy the line above
    // if that regex were any looser. Name it, so the failure mode has its own assertion.
    expect(stdout).not.toMatch(/NaN/);
  }, 120_000);
});
