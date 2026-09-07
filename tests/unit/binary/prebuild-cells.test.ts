import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { resolveCells, versionDrift, lockEntry, lockKey, splitTarget } from '../../../scripts/binary/cells.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { readManifest } from '../../../scripts/binary/manifest.mjs';

/*
 * WHY these tests exist.
 *
 * Every decision the harvest makes is in `resolveCells`: which package carries the binary for
 * a target, where upstream publishes it, which bytes to keep, where they land under
 * `libexec/`. A wrong row does not throw — it 404s, and a 404 is indistinguishable from
 * "upstream publishes no prebuild for this platform", which is the one message that must only
 * ever be true (DR-3 refuses; it never compiles, so a false refusal blocks a whole target).
 *
 * The rows most worth pinning are the ones no interpolation of `process.*` produces:
 * `sqlite-vec-windows-x64` (every other native spells win32 `win32`), the napi triples
 * `-linux-x64-gnu` / `-win32-x64-msvc`, and the libvips sibling that exists on darwin and
 * linux but not on win32.
 */

const REAL_LOCK = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));
const MANIFEST = readManifest();

interface Cell {
  id: string;
  native: string;
  pkg: string;
  version: string | null;
  target: string;
  optional: boolean;
  abiKind: string | null;
  napiVersion: number | null;
  source: { kind: string; url: string; integrity: string | null; asset?: string; abi?: string } | null;
  extract: { mode: string; from: string | null } | null;
  stageTo: string | null;
  unresolvable?: string;
}

function cellsFor(target: string, lock: unknown = REAL_LOCK): Cell[] {
  return resolveCells({ manifest: MANIFEST, lock, target });
}

function byNative(cells: Cell[], native: string): Cell[] {
  return cells.filter((c) => c.native === native);
}

describe('splitTarget', () => {
  it('splits on the LAST dash, so a triple-shaped target keeps its platform intact', () => {
    expect(splitTarget('darwin-arm64')).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(splitTarget('win32-x64')).toEqual({ platform: 'win32', arch: 'x64' });
  });

  it('refuses a string that is not <platform>-<arch>', () => {
    for (const bad of ['darwin', '-x64', 'darwin-', '']) {
      expect(() => splitTarget(bad), JSON.stringify(bad)).toThrow(/not <platform>-<arch>/);
    }
  });
});

describe('every mini-spec §1 target resolves every non-optional cell', () => {
  it.each(MANIFEST.targets)('%s', (target: string) => {
    const cells = cellsFor(target);
    const unresolved = cells.filter((c) => c.unresolvable && !c.optional);
    expect(unresolved.map((c) => `${c.id}: ${c.unresolvable}`)).toEqual([]);
    // Every native in the inventory must contribute at least one cell. A native that
    // silently contributes none is how a target ships missing a driver.
    for (const native of ['better-sqlite3', 'sqlite-vec', 'onnxruntime-node', 'sharp', '@napi-rs/keyring', 'wreq-js']) {
      expect(byNative(cells, native).length, `${native} on ${target}`).toBeGreaterThan(0);
    }
  });

  it('refuses a target the pin file does not list, naming the M6 verify-lane rule', () => {
    // A target with no platform-native verify lane drops from the ship matrix by amendment
    // (mini-spec §2 M6). Building one anyway is how an unverified artifact ships.
    expect(() => cellsFor('win32-arm64')).toThrow(/not in runtime.json targets.*M6/s);
  });
});

describe('the per-target package spellings no interpolation produces', () => {
  it('spells sqlite-vec win32 as "windows" — the trap that 404s like a missing prebuild', () => {
    expect(byNative(cellsFor('win32-x64'), 'sqlite-vec')[0].pkg).toBe('sqlite-vec-windows-x64');
    expect(byNative(cellsFor('darwin-arm64'), 'sqlite-vec')[0].pkg).toBe('sqlite-vec-darwin-arm64');
    expect(byNative(cellsFor('linux-arm64'), 'sqlite-vec')[0].pkg).toBe('sqlite-vec-linux-arm64');
  });

  it('uses napi triples for keyring, glibc on linux and msvc on win32', () => {
    const pkg = (target: string) => byNative(cellsFor(target), '@napi-rs/keyring')[0].pkg;
    expect(pkg('darwin-arm64')).toBe('@napi-rs/keyring-darwin-arm64');
    expect(pkg('linux-x64')).toBe('@napi-rs/keyring-linux-x64-gnu');
    expect(pkg('linux-arm64')).toBe('@napi-rs/keyring-linux-arm64-gnu');
    expect(pkg('win32-x64')).toBe('@napi-rs/keyring-win32-x64-msvc');
  });

  it('never harvests a musl build — musl is out of the ship matrix', () => {
    // The tree carries -musl packages and scripts/prune/wreq-binaries.mjs deliberately KEEPS
    // both libcs, because install-time and run-time libc detection can disagree. The binary
    // has no such ambiguity: mini-spec §1 puts musl out and install.sh refuses it by name.
    for (const target of MANIFEST.targets) {
      for (const cell of cellsFor(target)) {
        expect(`${cell.pkg} ${cell.extract?.from ?? ''}`, `${target} / ${cell.id}`).not.toMatch(/musl/);
      }
    }
  });

  it('slices exactly one wreq-js binary, in the loader’s own spelling', () => {
    const from = (target: string) => byNative(cellsFor(target), 'wreq-js')[0].extract!.from;
    expect(from('darwin-x64')).toBe('rust/wreq-js.darwin-x64.node');
    expect(from('linux-x64')).toBe('rust/wreq-js.linux-x64-gnu.node');
    expect(from('win32-x64')).toBe('rust/wreq-js.win32-x64-msvc.node');
  });

  it('slices onnxruntime at the path the package’s own binding.js interpolates', () => {
    // onnxruntime-node ships bin/napi-v3/{darwin,linux,win32}/{arm64,x64} — six runtimes,
    // 207.8 MiB measured — and dist/binding.js requires
    // `../bin/napi-v3/${process.platform}/${process.arch}/onnxruntime_binding.node`.
    const cell = byNative(cellsFor('win32-x64'), 'onnxruntime-node')[0];
    expect(cell.extract).toEqual({ mode: 'subdir', from: 'bin/napi-v3/win32/x64' });
    expect(cell.stageTo).toBe('node_modules/onnxruntime-node/bin/napi-v3/win32/x64');
    expect(byNative(cellsFor('linux-arm64'), 'onnxruntime-node')[0].extract!.from).toBe('bin/napi-v3/linux/arm64');
  });
});

describe('sharp’s libvips sibling is DERIVED from the lockfile, not hardcoded per platform', () => {
  it('darwin and linux get a libvips cell; win32 does not', () => {
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
      const pkgs = byNative(cellsFor(target), 'sharp').map((c) => c.pkg);
      expect(pkgs, target).toEqual([`@img/sharp-${target}`, `@img/sharp-libvips-${target}`]);
    }
    // win32 bundles its libvips DLLs inside the platform package; there is no sibling to fetch.
    expect(byNative(cellsFor('win32-x64'), 'sharp').map((c) => c.pkg)).toEqual(['@img/sharp-win32-x64']);
  });

  it('follows a sibling win32 gains, rather than the rule this repo happens to see today', () => {
    // The point of deriving: if upstream repackages win32 to use a sibling, the cell appears
    // with no edit here. A hardcoded "win32 has no libvips" would silently drop it.
    const lock = structuredClone(REAL_LOCK);
    lock.packages['node_modules/@img/sharp-win32-x64'].optionalDependencies = {
      '@img/sharp-libvips-win32-x64': '1.2.4',
    };
    lock.packages['node_modules/@img/sharp-libvips-win32-x64'] = {
      version: '1.2.4',
      resolved: 'https://registry.npmjs.org/@img/sharp-libvips-win32-x64/-/sharp-libvips-win32-x64-1.2.4.tgz',
      integrity: 'sha512-fake',
    };
    const pkgs = byNative(cellsFor('win32-x64', lock), 'sharp').map((c) => c.pkg);
    expect(pkgs).toEqual(['@img/sharp-win32-x64', '@img/sharp-libvips-win32-x64']);
  });

  it('drops a sibling upstream stops declaring, without failing the head cell', () => {
    const lock = structuredClone(REAL_LOCK);
    lock.packages['node_modules/@img/sharp-darwin-arm64'].optionalDependencies = {};
    expect(byNative(cellsFor('darwin-arm64', lock), 'sharp').map((c) => c.pkg)).toEqual(['@img/sharp-darwin-arm64']);
  });
});

describe('better-sqlite3 is the one cell whose URL carries the runtime ABI', () => {
  it('embeds the pinned ABI and the lockfile version in the asset name', () => {
    const cell = byNative(cellsFor('darwin-arm64'), 'better-sqlite3')[0];
    const version = REAL_LOCK.packages[lockKey('better-sqlite3')].version;
    expect(cell.source!.asset).toBe(`better-sqlite3-v${version}-node-v${MANIFEST.runtime.abi}-darwin-arm64.tar.gz`);
    expect(cell.source!.url).toBe(
      `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${cell.source!.asset}`
    );
    expect(cell.source!.abi).toBe(MANIFEST.runtime.abi);
  });

  it('moves with the pin, so bumping the runtime cannot reuse the previous ABI’s prebuild', () => {
    const bumped = { ...MANIFEST, runtime: { ...MANIFEST.runtime, abi: '137' } };
    const cell = resolveCells({ manifest: bumped, lock: REAL_LOCK, target: 'linux-x64' }).find(
      (c: Cell) => c.native === 'better-sqlite3'
    )!;
    expect(cell.source!.url).toContain('-node-v137-linux-x64.tar.gz');
  });

  it('records that upstream publishes no digest for it, rather than reading as verified', () => {
    // "no checksum available" and "checksum passed" must not be the same value downstream.
    const cell = byNative(cellsFor('darwin-arm64'), 'better-sqlite3')[0];
    expect(cell.source!.integrity).toBeNull();
    expect(cell.source!.kind).toBe('github-release');
  });

  it('verifies every npm cell against the lockfile’s upstream sha512', () => {
    for (const cell of cellsFor('darwin-arm64')) {
      if (cell.source!.kind !== 'npm-tarball') continue;
      expect(cell.source!.integrity, cell.id).toMatch(/^sha512-/);
      expect(cell.source!.url, cell.id).toContain('registry.npmjs.org');
    }
  });
});

describe('a cell the lockfile cannot describe is unresolvable, not silently skipped', () => {
  function withoutPackage(pkg: string) {
    const lock = structuredClone(REAL_LOCK);
    delete lock.packages[lockKey(pkg)];
    return lock;
  }

  it('marks a missing NON-optional package unresolvable, naming the lockfile key', () => {
    const cell = byNative(cellsFor('darwin-arm64', withoutPackage('sqlite-vec-darwin-arm64')), 'sqlite-vec')[0];
    expect(cell.optional).toBe(false);
    expect(cell.unresolvable).toMatch(/no "node_modules\/sqlite-vec-darwin-arm64" entry in package-lock.json/);
    expect(cell.source).toBeNull();
  });

  it('marks a missing OPTIONAL package unresolvable AND optional, so the caller degrades', () => {
    const cell = byNative(cellsFor('linux-x64', withoutPackage('@napi-rs/keyring-linux-x64-gnu')), '@napi-rs/keyring')[0];
    expect(cell.optional).toBe(true);
    expect(cell.unresolvable).toMatch(/no "node_modules\/@napi-rs\/keyring-linux-x64-gnu" entry/);
  });

  it('refuses an entry with no resolved URL', () => {
    const lock = structuredClone(REAL_LOCK);
    delete lock.packages[lockKey('sqlite-vec-darwin-arm64')].resolved;
    expect(byNative(cellsFor('darwin-arm64', lock), 'sqlite-vec')[0].unresolvable).toMatch(/has no "resolved" URL/);
  });

  it('refuses an entry with no integrity hash — there would be nothing to verify against', () => {
    const lock = structuredClone(REAL_LOCK);
    delete lock.packages[lockKey('sqlite-vec-darwin-arm64')].integrity;
    expect(byNative(cellsFor('darwin-arm64', lock), 'sqlite-vec')[0].unresolvable).toMatch(/no "integrity" hash/);
  });

  it('refuses a native pinned with no source mapping, instead of resolving zero cells for it', () => {
    // The failure this closes: runtime.json gains a native, the resolver ignores it, and the
    // run reports a complete staging dir that is missing a native.
    const manifest = {
      ...MANIFEST,
      natives: { ...MANIFEST.natives, 'node-canvas': { lockPath: 'node_modules/node-canvas', abiKind: 'napi', napiVersion: null, optional: false } },
    };
    expect(() => resolveCells({ manifest, lock: REAL_LOCK, target: 'darwin-arm64' })).toThrow(
      /declares native "node-canvas" but cells.mjs has no source mapping/
    );
  });
});

describe('lockEntry', () => {
  it('reads version, resolved, integrity and optionalDependencies', () => {
    const entry = lockEntry(REAL_LOCK, 'better-sqlite3');
    expect(entry.version).toBe(REAL_LOCK.packages['node_modules/better-sqlite3'].version);
    expect(entry.pkg).toBe('better-sqlite3');
  });

  it('returns null rather than a half-built entry for a package that is not there', () => {
    expect(lockEntry(REAL_LOCK, 'not-a-real-package')).toBeNull();
    expect(lockEntry({}, 'better-sqlite3')).toBeNull();
  });
});

describe('versionDrift — the check that catches a staging dir built before a dep bump', () => {
  const harvested = {
    cells: [
      { pkg: 'better-sqlite3', version: REAL_LOCK.packages['node_modules/better-sqlite3'].version },
      { pkg: 'sqlite-vec-darwin-arm64', version: REAL_LOCK.packages['node_modules/sqlite-vec-darwin-arm64'].version },
    ],
  };

  it('is silent when every recorded version still matches the lockfile', () => {
    expect(versionDrift(harvested, REAL_LOCK)).toEqual([]);
  });

  it('names the package, the harvested version and the lockfile version on a bump', () => {
    const lock = structuredClone(REAL_LOCK);
    lock.packages['node_modules/better-sqlite3'].version = '12.10.0';
    expect(versionDrift(harvested, lock)).toEqual([
      `better-sqlite3: harvested ${harvested.cells[0].version}, package-lock.json says 12.10.0`,
    ]);
  });

  it('reports a package that has left the lockfile entirely', () => {
    const lock = structuredClone(REAL_LOCK);
    delete lock.packages['node_modules/sqlite-vec-darwin-arm64'];
    expect(versionDrift(harvested, lock)[0]).toMatch(/no longer contains "node_modules\/sqlite-vec-darwin-arm64"/);
  });

  it('ignores cells recorded as absent, which carry no version to compare', () => {
    const doc = { cells: [{ pkg: '@napi-rs/keyring-linux-arm64-gnu', version: null }] };
    expect(versionDrift(doc, REAL_LOCK)).toEqual([]);
  });

  it('reports every drifted cell, not just the first', () => {
    const lock = structuredClone(REAL_LOCK);
    lock.packages['node_modules/better-sqlite3'].version = '12.10.0';
    lock.packages['node_modules/sqlite-vec-darwin-arm64'].version = '0.2.0';
    expect(versionDrift(harvested, lock)).toHaveLength(2);
  });
});
