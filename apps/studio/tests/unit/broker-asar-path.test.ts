import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { toUnpackedPath, resolveBrokerPathFrom, resolveDatabaseModulePath } from '../../src/main/broker-client';

/**
 * The packaged spawn seam.
 *
 * The defect this file exists to prevent shipped green through typecheck, unit, e2e AND CI, and was
 * found only by launching the artifact: `resolveBrokerPath()` anchored resolution at `import.meta.url`,
 * which in a packaged app is inside `app.asar`. The Electron main resolves that happily — the asar
 * archive is a virtual filesystem Electron patches into its own `fs`. But the broker is a PLAIN-NODE
 * child process (spec §13.7), and plain Node has no such patch, so it was handed the path of a file
 * that, from where it stands, does not exist. Gateway up, broker dead.
 *
 * The fixture below is a faithful model of the two trees a packaged app has:
 *   app.asar/…            what the Electron main sees (here: a real directory standing in for the
 *                         archive's virtual contents)
 *   app.asar.unpacked/…   what is genuinely on disk, and the ONLY thing a plain-Node child can open
 *
 * A test that only checked "the path resolves" would have passed on the broken code. What has to be
 * asserted is WHERE it resolves to, and that the result is a real file.
 *
 * This runs in ordinary CI — no packaging, no RUN_STUDIO_PACKAGE_E2E gate. The gated
 * `tests/e2e/packaging.spec.ts` proves the same thing against a real artifact; this proves it on every
 * push.
 */

let root: string;
let asarAnchor: string;

/** Writes a minimal `wigolo` package exposing the broker subpath, plus a stand-in database engine. */
function seedTree(base: string): void {
  const wigolo = join(base, 'node_modules', 'wigolo');
  mkdirSync(join(wigolo, 'dist', 'daemon'), { recursive: true });
  writeFileSync(
    join(wigolo, 'package.json'),
    JSON.stringify({
      name: 'wigolo',
      version: '0.0.0-fixture',
      exports: { './studio-db-broker': './dist/daemon/studio-db-broker.js' },
    }),
  );
  writeFileSync(join(wigolo, 'dist', 'daemon', 'studio-db-broker.js'), '// broker entry fixture\n');

  // The engine the ABI probe validates against. It is resolved FROM the broker entry, so it inherits
  // whichever tree the broker path came from — the probe cannot be correct while the entry is wrong.
  const db = join(base, 'node_modules', 'better-sqlite3');
  mkdirSync(db, { recursive: true });
  writeFileSync(join(db, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '0.0.0-fixture', main: 'index.js' }));
  writeFileSync(join(db, 'index.js'), 'module.exports = {};\n');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wigolo-asar-'));
  const resources = join(root, 'Contents', 'Resources');
  // Both trees carry the package. In a real artifact the archive copy is a member of a single file
  // named `app.asar`; modelling it as a directory is what lets the unfixed resolution succeed here,
  // which is precisely the trap — it succeeds for the Electron main and is useless to the child.
  seedTree(join(resources, 'app.asar'));
  seedTree(join(resources, 'app.asar.unpacked'));
  mkdirSync(join(resources, 'app.asar', 'out', 'main'), { recursive: true });
  asarAnchor = join(resources, 'app.asar', 'out', 'main', 'index.js');
  writeFileSync(asarAnchor, '// packaged main bundle\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('toUnpackedPath', () => {
  it('redirects a path inside the archive to the sibling unpacked tree', () => {
    expect(toUnpackedPath(join('/A', 'app.asar', 'out', 'main', 'index.js'))).toBe(
      join('/A', 'app.asar.unpacked', 'out', 'main', 'index.js'),
    );
  });

  it('is idempotent — an already-unpacked path is left exactly alone', () => {
    // Applying the rewrite twice must not yield `app.asar.unpacked.unpacked`. A naive substring
    // replace of `app.asar` does exactly that, and the resulting directory never exists, so the
    // failure would look identical to the bug being fixed.
    const unpacked = join('/A', 'app.asar.unpacked', 'node_modules', 'wigolo', 'x.js');
    expect(toUnpackedPath(unpacked)).toBe(unpacked);
    expect(toUnpackedPath(toUnpackedPath(join('/A', 'app.asar', 'x.js')))).toBe(join('/A', 'app.asar.unpacked', 'x.js'));
  });

  it('leaves an unpackaged dev path untouched', () => {
    // Dev and test runs must take the same code path as production, not a branch nobody exercises.
    const dev = join('/repo', 'apps', 'studio', 'out', 'main', 'index.js');
    expect(toUnpackedPath(dev)).toBe(dev);
  });

  it('only rewrites a whole path segment, never a directory that merely contains ".asar"', () => {
    const notAnArchive = join('/A', 'my.asar.backup', 'x.js');
    expect(toUnpackedPath(notAnArchive)).toBe(notAnArchive);
  });
});

describe('resolveBrokerPathFrom — the packaged spawn seam', () => {
  it('resolves the broker entry OUT of the archive and onto the real filesystem', () => {
    const resolved = resolveBrokerPathFrom(asarAnchor);
    expect(resolved).toContain(`${sep}app.asar.unpacked${sep}`);
    expect(resolved).not.toContain(`${sep}app.asar${sep}`);
    // The property that actually decides whether the child boots: a plain-Node `node <path>` has to
    // be able to open this file with no asar layer in front of it.
    expect(existsSync(resolved)).toBe(true);
  });

  it('differs from the pre-fix resolution, which pointed inside the archive', () => {
    // The base-vs-tip differential, kept in the test rather than in a commit message. Without it,
    // "resolves to a real file" could be satisfied by an artifact where nothing was archived at all,
    // and the assertion above would stop being able to fail.
    const preFix = createRequire(asarAnchor).resolve('wigolo/studio-db-broker');
    expect(preFix).toContain(`${sep}app.asar${sep}`);
    expect(preFix).not.toBe(resolveBrokerPathFrom(asarAnchor));
  });

  it('carries the database engine out of the archive with it', () => {
    // The ABI probe spawns plain Node on this path. Resolved from an archived broker entry it would
    // name an archived engine, the probe would fail to load it, and every candidate runtime would be
    // rejected — the broker refusing to start for a reason that has nothing to do with ABI.
    const engine = resolveDatabaseModulePath(resolveBrokerPathFrom(asarAnchor));
    expect(engine).toContain(`${sep}app.asar.unpacked${sep}`);
    expect(existsSync(engine)).toBe(true);
  });

  it('is a no-op for an unpackaged tree', () => {
    // Resolution from the loose `app.asar.unpacked` tree must land in that same tree — proof the
    // rewrite is not smuggling in a second, different resolution root.
    const looseAnchor = join(root, 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'main', 'index.js');
    expect(resolveBrokerPathFrom(looseAnchor)).toBe(resolveBrokerPathFrom(asarAnchor));
  });
});
