/*
 * The cell resolver: (native x target) -> exactly one fetchable, stageable descriptor.
 *
 * WHY THIS IS PURE AND SEPARATE FROM THE FETCHER.
 *
 * Every interesting decision in the harvest is here: which package carries the binary for a
 * target, where upstream publishes it, which bytes to keep, and where they land under
 * `libexec/`. Getting one of those wrong does not throw — it 404s, or it stages an empty
 * directory, and both look like "upstream has no prebuild for this platform", which is the
 * one message that must only ever be true. So the mapping lives in a function with no
 * network and no filesystem, and every row of it is asserted against literals.
 *
 * WHY THE PACKAGE NAMES ARE TABLES AND NOT INTERPOLATIONS.
 *
 * There is no single spelling of a target across our six natives, and every deviation below
 * was read off `package-lock.json`, not inferred:
 *
 *   target        sqlite-vec              @img/sharp        @napi-rs/keyring          wreq-js
 *   darwin-arm64  -darwin-arm64           -darwin-arm64     -darwin-arm64            .darwin-arm64
 *   linux-x64     -linux-x64              -linux-x64        -linux-x64-gnu           .linux-x64-gnu
 *   win32-x64     -windows-x64  (!)       -win32-x64        -win32-x64-msvc          .win32-x64-msvc
 *
 * `sqlite-vec-windows-x64` is the trap: every other native spells win32 as `win32`. An
 * interpolation of `process.platform` produces `sqlite-vec-win32-x64`, which does not exist
 * and 404s exactly like a genuinely missing prebuild.
 *
 * MUSL IS OUT OF THE MATRIX. `@napi-rs/keyring` and `wreq-js` both publish `-musl` builds and
 * `scripts/prune/wreq-binaries.mjs` deliberately keeps both libcs for the host arch, because
 * install-time and run-time libc detection can disagree on one machine. The binary has no
 * such ambiguity: mini-spec 1 puts musl/Alpine out of the ship matrix and install.sh refuses
 * it by name, so linux cells are gnu-only. Adding musl is a spec amendment, not a table edit.
 */

/**
 * `node_modules/...` lockfile key for a package name.
 * @param {string} pkg
 */
export function lockKey(pkg) {
  return `node_modules/${pkg}`;
}

/** @param {string} target `<platform>-<arch>` */
export function splitTarget(target) {
  const at = target.lastIndexOf('-');
  if (at <= 0 || at === target.length - 1) {
    throw new Error(`target "${target}" is not <platform>-<arch>`);
  }
  return { platform: target.slice(0, at), arch: target.slice(at + 1) };
}

/** sqlite-vec's own spelling of the five targets. `windows`, not `win32`. */
const SQLITE_VEC_PKG = Object.freeze({
  'darwin-arm64': 'sqlite-vec-darwin-arm64',
  'darwin-x64': 'sqlite-vec-darwin-x64',
  'linux-x64': 'sqlite-vec-linux-x64',
  'linux-arm64': 'sqlite-vec-linux-arm64',
  'win32-x64': 'sqlite-vec-windows-x64',
});

/** napi-rs triples, as `@napi-rs/keyring` publishes them. glibc only (see the header). */
const KEYRING_PKG = Object.freeze({
  'darwin-arm64': '@napi-rs/keyring-darwin-arm64',
  'darwin-x64': '@napi-rs/keyring-darwin-x64',
  'linux-x64': '@napi-rs/keyring-linux-x64-gnu',
  'linux-arm64': '@napi-rs/keyring-linux-arm64-gnu',
  'win32-x64': '@napi-rs/keyring-win32-x64-msvc',
});

/**
 * The one file `wreq-js` ships per target, in the loader's own spelling.
 *
 * Kept as an allowlist rather than a pattern for the same reason
 * `scripts/prune/wreq-binaries.mjs` does: these are napi triple names that no interpolation
 * of `process.*` produces.
 */
const WREQ_BINARY = Object.freeze({
  'darwin-arm64': 'wreq-js.darwin-arm64.node',
  'darwin-x64': 'wreq-js.darwin-x64.node',
  'linux-x64': 'wreq-js.linux-x64-gnu.node',
  'linux-arm64': 'wreq-js.linux-arm64-gnu.node',
  'win32-x64': 'wreq-js.win32-x64-msvc.node',
});

/**
 * A lockfile entry, or `null` when the lockfile has no such package.
 *
 * `resolved` and `integrity` are both required for an npm cell: `integrity` IS the
 * upstream-published checksum the spec asks us to verify where one exists, and a lockfile
 * entry without it cannot be verified at all.
 *
 * @param {object} lock parsed package-lock.json
 * @param {string} pkg
 */
export function lockEntry(lock, pkg) {
  const entry = lock?.packages?.[lockKey(pkg)];
  if (!entry || typeof entry.version !== 'string') return null;
  return {
    pkg,
    version: entry.version,
    resolved: typeof entry.resolved === 'string' ? entry.resolved : null,
    integrity: typeof entry.integrity === 'string' ? entry.integrity : null,
    optionalDependencies: entry.optionalDependencies ?? {},
  };
}

function npmCell({ native, target, entry, optional, abiKind, napiVersion, extract, stageTo }) {
  return {
    id: `${entry.pkg}@${entry.version}/${target}`,
    native,
    pkg: entry.pkg,
    version: entry.version,
    target,
    optional,
    abiKind,
    napiVersion,
    source: {
      kind: 'npm-tarball',
      url: entry.resolved,
      // sha512 from the registry, recorded in our own lockfile: an upstream-published
      // checksum, so it is verified rather than merely computed.
      integrity: entry.integrity,
    },
    extract,
    stageTo,
  };
}

/**
 * A cell that cannot be built because the lockfile does not describe it.
 *
 * Returned rather than thrown so the caller decides: a non-optional unresolvable cell is a
 * refusal naming the cell (DR-3), an optional one is an absence recorded in the manifest.
 */
function unresolvable({ native, target, pkg, optional, reason }) {
  return {
    id: `${pkg}/${target}`,
    native,
    pkg,
    version: null,
    target,
    optional,
    abiKind: null,
    napiVersion: null,
    source: null,
    extract: null,
    stageTo: null,
    unresolvable: reason,
  };
}

function requireNpm({ native, target, pkg, optional, lock, spec, extract, stageTo }) {
  const entry = lockEntry(lock, pkg);
  if (!entry) {
    return unresolvable({ native, target, pkg, optional, reason: `no "${lockKey(pkg)}" entry in package-lock.json` });
  }
  if (!entry.resolved) {
    return unresolvable({ native, target, pkg, optional, reason: `package-lock.json entry "${lockKey(pkg)}" has no "resolved" URL` });
  }
  if (!entry.integrity) {
    return unresolvable({ native, target, pkg, optional, reason: `package-lock.json entry "${lockKey(pkg)}" has no "integrity" hash to verify against` });
  }
  return npmCell({
    native,
    target,
    entry,
    optional,
    abiKind: spec.abiKind,
    napiVersion: spec.napiVersion,
    extract,
    stageTo: stageTo(entry.pkg),
  });
}

/**
 * `better-sqlite3` — the only native whose prebuild is a GitHub release asset rather than an
 * npm package, and the only one whose artifact name embeds the runtime ABI.
 */
function betterSqlite3Cells({ target, lock, spec, runtime }) {
  const { platform, arch } = splitTarget(target);
  const entry = lockEntry(lock, 'better-sqlite3');
  if (!entry) {
    return [unresolvable({ native: 'better-sqlite3', target, pkg: 'better-sqlite3', optional: spec.optional, reason: 'no "node_modules/better-sqlite3" entry in package-lock.json' })];
  }
  const asset = `better-sqlite3-v${entry.version}-node-v${runtime.abi}-${platform}-${arch}.tar.gz`;
  return [
    {
      id: `better-sqlite3@${entry.version}/${target}`,
      native: 'better-sqlite3',
      pkg: 'better-sqlite3',
      version: entry.version,
      target,
      optional: spec.optional,
      abiKind: spec.abiKind,
      napiVersion: spec.napiVersion,
      source: {
        kind: 'github-release',
        url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v${entry.version}/${asset}`,
        asset,
        // The ABI is IN the asset name, so it is asserted against the pin rather than hoped for.
        abi: runtime.abi,
        // Upstream publishes no digest beside the release assets. Recorded, not pretended:
        // the harvest computes and records a sha256 so the artifact is reproducible-checkable
        // downstream, and says in the manifest that no upstream digest existed to compare to.
        integrity: null,
        integrityNote: 'upstream publishes no checksum for better-sqlite3 release assets; sha256 is computed and recorded',
      },
      extract: { mode: 'file', from: 'build/Release/better_sqlite3.node' },
      stageTo: 'node_modules/better-sqlite3/build/Release',
    },
  ];
}

/**
 * `sharp` — the platform package plus whatever libvips sibling IT declares.
 *
 * The sibling set is derived from the platform package's own `optionalDependencies` in the
 * lockfile, never from a per-platform rule here. That matters: `@img/sharp-win32-x64` has no
 * `@img/sharp-libvips-win32-x64` sibling (win32 bundles its libvips DLLs inside the platform
 * package) while darwin and linux do, and hardcoding that asymmetry is how the next
 * repackaging upstream does silently drops libvips out of one platform's artifact.
 */
function sharpCells({ target, lock, spec }) {
  const pkg = `@img/sharp-${target}`;
  const head = requireNpm({
    native: 'sharp',
    target,
    pkg,
    optional: spec.optional,
    lock,
    spec,
    extract: { mode: 'package', from: null },
    stageTo: (name) => `node_modules/${name}`,
  });
  const cells = [head];
  if (head.unresolvable) return cells;

  const entry = lockEntry(lock, pkg);
  const siblings = Object.keys(entry.optionalDependencies).filter((d) => d.startsWith('@img/sharp-libvips-'));
  for (const sibling of siblings) {
    cells.push(
      requireNpm({
        native: 'sharp',
        target,
        pkg: sibling,
        optional: spec.optional,
        lock,
        spec,
        extract: { mode: 'package', from: null },
        stageTo: (name) => `node_modules/${name}`,
      })
    );
  }
  return cells;
}

/**
 * Resolve every cell one target needs.
 *
 * @param {object} args
 * @param {Readonly<object>} args.manifest validated `runtime.json`
 * @param {object} args.lock parsed `package-lock.json`
 * @param {string} args.target one of `manifest.targets`
 * @returns {object[]} one cell per artifact to fetch; `sharp` contributes more than one
 */
export function resolveCells({ manifest, lock, target }) {
  if (!manifest.targets.includes(target)) {
    throw new Error(
      `target "${target}" is not in runtime.json targets [${manifest.targets.join(', ')}]` +
        ' — a target that is not pinned has no verify lane and must not be built (mini-spec 2 M6)'
    );
  }
  const { platform, arch } = splitTarget(target);
  const runtime = manifest.runtime;
  const cells = [];

  for (const [native, spec] of Object.entries(manifest.natives)) {
    if (native.startsWith('$')) continue;

    switch (native) {
      case 'better-sqlite3':
        cells.push(...betterSqlite3Cells({ target, lock, spec, runtime }));
        break;

      case 'sqlite-vec':
        cells.push(
          requireNpm({
            native,
            target,
            pkg: SQLITE_VEC_PKG[target],
            optional: spec.optional,
            lock,
            spec,
            extract: { mode: 'package', from: null },
            stageTo: (name) => `node_modules/${name}`,
          })
        );
        break;

      case 'onnxruntime-node':
        // One package, six platform pairs inside it (scripts/prune/ort-platforms.mjs measured
        // 207.8 MiB of them). Slice the pair, at the exact path the package's own
        // `dist/binding.js` interpolates: bin/napi-v3/${process.platform}/${process.arch}.
        cells.push(
          requireNpm({
            native,
            target,
            pkg: 'onnxruntime-node',
            optional: spec.optional,
            lock,
            spec,
            extract: { mode: 'subdir', from: `bin/napi-v${spec.napiVersion}/${platform}/${arch}` },
            stageTo: () => `node_modules/onnxruntime-node/bin/napi-v${spec.napiVersion}/${platform}/${arch}`,
          })
        );
        break;

      case 'sharp':
        cells.push(...sharpCells({ target, lock, spec }));
        break;

      case '@napi-rs/keyring':
        cells.push(
          requireNpm({
            native,
            target,
            pkg: KEYRING_PKG[target],
            optional: spec.optional,
            lock,
            spec,
            extract: { mode: 'package', from: null },
            stageTo: (name) => `node_modules/${name}`,
          })
        );
        break;

      case 'wreq-js':
        cells.push(
          requireNpm({
            native,
            target,
            pkg: 'wreq-js',
            optional: spec.optional,
            lock,
            spec,
            extract: { mode: 'file', from: `rust/${WREQ_BINARY[target]}` },
            stageTo: () => 'node_modules/wreq-js/rust',
          })
        );
        break;

      default:
        // A native added to runtime.json with no source mapping here would otherwise resolve
        // to nothing and the run would report a complete staging dir that is missing a native.
        throw new Error(
          `runtime.json declares native "${native}" but cells.mjs has no source mapping for it` +
            ' — add one (and its per-target package spelling) before pinning it'
        );
    }
  }

  return cells;
}

/**
 * Re-assert every recorded cell version against the lockfile.
 *
 * THE DRIFT THIS CATCHES. A staging dir, or a manifest, produced before a dependency bump.
 * The resolver reads versions from the lockfile at resolve time, so a same-run comparison
 * would be circular; this one compares what a PREVIOUS run recorded against the lockfile as
 * it is now. That is the shape that ships an ABI-mismatched or simply stale native looking
 * green, which is the whole reason DR-3 exists.
 *
 * @param {object} harvest a `harvest-manifest.json` document
 * @param {object} lock parsed `package-lock.json`
 * @returns {string[]} one message per drifted cell; empty means no drift
 */
export function versionDrift(harvest, lock) {
  const drifted = [];
  for (const cell of harvest?.cells ?? []) {
    if (cell.version === null || cell.version === undefined) continue;
    const entry = lockEntry(lock, cell.pkg);
    if (!entry) {
      drifted.push(`${cell.pkg}: harvested ${cell.version}, package-lock.json no longer contains "${lockKey(cell.pkg)}"`);
      continue;
    }
    if (entry.version !== cell.version) {
      drifted.push(`${cell.pkg}: harvested ${cell.version}, package-lock.json says ${entry.version}`);
    }
  }
  return drifted;
}
