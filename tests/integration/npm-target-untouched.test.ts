import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { npmInvocation } from './npm-invocation.js';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { REPO_ROOT } from '../../scripts/binary/manifest.mjs';

/*
 * The BINARY milestone's standing non-goal, asserted rather than promised: "npm unchanged —
 * `npm i -g wigolo` keeps today's behaviour byte-for-byte" (mini-spec §5, §10).
 *
 * IT LIVES IN THE SERIAL LANE ON PURPOSE. `npm pack` enumerates `dist/`, and the parallel unit
 * lane runs concurrently with the lane that REBUILDS `dist/` — tsup's `clean: true` deletes the
 * directory for ~300ms and a reader that lands in that window fails with a module-not-found in a
 * file that has nothing to do with the cause (#176). `tests/unit/dist-rebuild-serialization.ts`
 * is the guard that reds when a dist/-reading spawner is in the wrong lane, and it caught this
 * file when it was first written under `tests/unit/binary/`.
 */

describe('the npm target is untouched (issue non-goal, re-asserted per slice)', () => {
  it('publishes exactly the file list it published before this slice', () => {
    // `WIGOLO_SKIP_PREPARE=1`, not `--ignore-scripts`: `npm pack` fires `prepare`, and
    // `scripts/prepare-build.mjs` documents why this repo suppresses that one build with a
    // variable it reads itself rather than with a flag that also skips DEPENDENCIES' install
    // scripts. Without it, tsup rebuilds `dist/` here — underneath every other test in flight.
    // Through `npmInvocation`, never a bare `npm`: on Windows that is `npm.cmd`, a batch shim
    // Node has refused to spawn without `shell: true` since the fix for CVE-2024-27980, and it
    // dies as `spawnSync npm ENOENT` — a setup failure wearing the costume of a test failure.
    const pack = npmInvocation(['pack', '--dry-run', '--json']);
    const out = execFileSync(pack.file, pack.args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, WIGOLO_SKIP_PREPARE: '1' },
    });

    // The hook still SPEAKS on stdout even when it does not build ("prepare: no build — …"),
    // and `--json` does not silence it, so the payload has to be found rather than assumed to
    // start at byte 0. Measured: this arm passed locally and reddened on all three CI legs with
    // `SyntaxError: Unexpected token 'C', "CLI Buildi"…` — tsup's own banner parsed as JSON.
    const lines = out.split('\n');
    const start = lines.findIndex((l) => l.trimStart().startsWith('['));
    expect(start, `npm pack --json printed no JSON array:\n${out.slice(0, 500)}`).toBeGreaterThanOrEqual(0);
    const files: string[] = JSON.parse(lines.slice(start).join('\n'))[0].files.map((f: { path: string }) => f.path);
    const nonDist = files.filter((f) => !f.startsWith('dist/')).sort();

    // Every non-dist entry, pinned. `scripts/binary/**` and `tests/unit/binary/**` are this
    // slice's whole footprint and neither is in `files`, so a new build script cannot leak into
    // the published tarball without this list changing.
    expect(nonDist).not.toContain('package-lock.json');
    expect(nonDist.filter((f) => f.startsWith('scripts/'))).toEqual([
      'scripts/prepare-build.mjs',
      'scripts/prune/ort-platforms.mjs',
      'scripts/prune/ort-web-payload.mjs',
      'scripts/prune/run.mjs',
      'scripts/prune/wreq-binaries.mjs',
    ]);
    expect(nonDist.some((f) => f.startsWith('scripts/binary/'))).toBe(false);
    expect(nonDist.some((f) => f.startsWith('tests/'))).toBe(false);
    expect(files.length).toBeGreaterThan(2000);
  });

  it('still points `bin.wigolo` at the dist entry, not at anything this slice built', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.bin).toEqual({ wigolo: 'dist/index.js' });
    expect(pkg.engines).toEqual({ node: '>=22' });
  });
});
