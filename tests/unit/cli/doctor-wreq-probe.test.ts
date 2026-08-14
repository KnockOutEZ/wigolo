import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { probeWreqJsAvailable, wreqHostBinaries } from '../../../src/cli/doctor.js';

/*
 * WHY this file exists.
 *
 * `probeWreqJsAvailable` is the function `doctor` actually calls to decide whether it prints
 * `tls_tier: auto (chrome_147, wreq-js ✓)` or `wreq-js missing — fallback only`. Until now it was
 * NOT EXPORTED, and the only doctor-level assertion covering it was
 * `expect(outBuffer).toMatch(/wreq-js (✓|missing)/)` — which passes whichever answer it gives.
 * Reverting the probe to its old resolve-only body would have reddened nothing at all.
 *
 * ⚠ THAT IS THE SAME DEFECT ONE LEVEL UP FROM THE ONE #307 FIXED. #307 extracted
 * `hasLoadableWreqBinary` precisely because unexported code is code no test can hold accountable —
 * and then left its only caller unexported, so the half that survived was the half that had just
 * been argued to be untestable-and-therefore-wrong.
 *
 * The uncovered part is the root derivation: `dirname(dirname(resolve('wreq-js')))`. It is two
 * dirnames because the `.` export lands on `<root>/dist/wreq-js.cjs` while the binaries live at
 * `<root>/rust/`. Getting the count wrong fails CLOSED today — doctor reports the tier missing
 * while it works — so this was a coverage hole rather than a live bug, and it is the kind that
 * turns into a live bug the first time somebody "simplifies" the expression.
 */

const trees: string[] = [];
afterAll(() => {
  for (const dir of trees) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake wreq-js install. `binariesAt` places the host binaries under `<root>/<dir>/rust/`, so a
 * fixture can put them exactly where a MIS-derived root would look instead of where the real one
 * does.
 */
function plantPackage(opts: { binariesAt: string[] }): { entry: string; root: string } {
  const parent = mkdtempSync(join(tmpdir(), 'wreq-probe-'));
  trees.push(parent);
  const root = join(parent, 'node_modules', 'wreq-js');
  mkdirSync(join(root, 'dist'), { recursive: true });
  const entry = join(root, 'dist', 'wreq-js.cjs');
  writeFileSync(entry, '// loader');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'wreq-js', version: '2.3.1' }));

  for (const rel of opts.binariesAt) {
    const dir = join(root, rel, 'rust');
    mkdirSync(dir, { recursive: true });
    // Whatever this host could load. On a host the loader does not support this is empty, and the
    // probe must answer false for want of a candidate rather than for want of a directory.
    for (const name of wreqHostBinaries(process.platform, process.arch)) {
      writeFileSync(join(dir, name), 'x');
    }
  }
  return { entry, root };
}

const HOST_IS_SUPPORTED = wreqHostBinaries(process.platform, process.arch).length > 0;

describe('probeWreqJsAvailable derives the package root from the resolved entry', () => {
  it('finds the binaries two levels up from `dist/wreq-js.cjs`', () => {
    // The must-fire direction. `<root>/dist/wreq-js.cjs` -> `<root>` -> `<root>/rust/`.
    // ⚠ NOTHING is planted at the one-dirname or three-dirname locations, which is what gives this
    // teeth: a probe that looked in `<root>/dist/rust` or in the parent of `<root>` finds an empty
    // filesystem and reds here.
    const { entry } = plantPackage({ binariesAt: [''] });
    expect(probeWreqJsAvailable(() => entry)).toBe(HOST_IS_SUPPORTED);
  });

  it('does NOT accept binaries sitting where a mis-derived root would look', () => {
    // The must-not-fire direction, and the other half of pinning the count to exactly two. Here
    // the binaries are ONLY at `<root>/dist/rust` (one dirname) and at the parent of `<root>`
    // (three) — a probe that walked the wrong number of levels, or hedged by trying several,
    // answers true. The real loader requires `../rust/<name>` relative to `dist/`, so anything
    // found at those paths is a file it would never load, and reporting the tier alive on one is
    // the exact lie #307 was written to stop.
    const { entry, root } = plantPackage({ binariesAt: ['dist'] });
    const grandparent = join(dirname(root), 'rust');
    mkdirSync(grandparent, { recursive: true });
    for (const name of wreqHostBinaries(process.platform, process.arch)) {
      writeFileSync(join(grandparent, name), 'x');
    }
    expect(probeWreqJsAvailable(() => entry)).toBe(false);
  });

  it('reports missing rather than throwing when the package cannot be resolved at all', () => {
    // `wreq-js` is an optionalDependency and `npm i --omit=optional` is a supported install, so
    // this is an ordinary state, not an exceptional one. A probe that let the throw escape would
    // take `doctor` down with it.
    expect(
      probeWreqJsAvailable(() => {
        throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
      }),
    ).toBe(false);
  });

  it('reports missing for a resolvable package the prune has emptied', () => {
    // ⚠ THE STATE THE PRUNE NEWLY CREATES, at the seam doctor actually calls. Resolving says
    // nothing about `rust/`, which is why the old resolve-only body printed `wreq-js ✓` over a
    // dead tier. `binariesAt: []` is a package that resolves and holds nothing loadable.
    const { entry } = plantPackage({ binariesAt: [] });
    expect(probeWreqJsAvailable(() => entry)).toBe(false);
  });
});

describe('the DEFAULT resolver points at the real installed package', () => {
  it('derives a directory that is genuinely wreq-js, or reports missing', () => {
    // ⚠ THE OUTSIDE SIGNAL. Every assertion above uses a fixture this file built, so together they
    // only prove the probe is self-consistent with a layout this file invented. This one checks
    // the derivation against the package as actually published: two dirnames from the resolved `.`
    // export must land on a directory whose package.json says `wreq-js`.
    //
    // The branch is not a hedge — wreq-js is optional, and on a host where it is absent the
    // meaningful assertion is that the probe says so instead of throwing. Both sides assert.
    const req = createRequire(import.meta.url);
    let entry: string | null = null;
    try {
      entry = req.resolve('wreq-js');
    } catch {
      entry = null;
    }

    if (entry === null) {
      expect(probeWreqJsAvailable()).toBe(false);
      return;
    }
    const root = dirname(dirname(entry));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(manifest.name).toBe('wreq-js');
  });
});
