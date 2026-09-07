import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    // `--ignore-scripts` so `prepack` does not rebuild dist/ underneath a parallel test, and so
    // the file list is the one `files` declares rather than one a build happened to leave.
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
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
