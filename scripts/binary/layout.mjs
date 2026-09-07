/*
 * The mini-spec §4 artifact contract, as code.
 *
 * Everything in this file is PURE — no I/O, no network, no process state — because every
 * consumer of the contract (install.sh, the brew formula, the studio dmg's stage step) reads
 * the SHAPE, and a shape that can only be checked by running a 100 MB build is a shape nobody
 * checks. The build script does the I/O; this file decides what the names and the bytes say.
 *
 * WHAT THE CONTRACT ACTUALLY IS (§4, "Guarantees to consumers"):
 *
 *   wigolo/
 *     bin/wigolo[.exe]   the executable
 *     libexec/           natives + runtime support, layout OPAQUE to consumers
 *     LICENSES/          aggregated third-party licenses incl. the embedded runtime's
 *     VERSION            semver + toolchain + runtime + ABI + target
 *
 * The one top-level `wigolo/` dir is load-bearing: `tar xzf` of a flat archive into a shared
 * directory scatters `bin/` and `libexec/` over whatever is already there.
 */

/** Targets are always `<platform>-<arch>`; splitting them anywhere else would be a second parser. */
export function splitTarget(target) {
  const dash = target.indexOf('-');
  if (dash === -1) throw new Error(`target must be <platform>-<arch>, got ${JSON.stringify(target)}`);
  return { platform: target.slice(0, dash), arch: target.slice(dash + 1) };
}

/**
 * Archive extension. `.zip` on win32, `.tar.gz` everywhere else (§4 naming).
 *
 * Not a lookup table keyed on all five targets: the rule is about what the DESTINATION OS can
 * unpack without a third-party tool, so it keys on platform alone and a sixth target inherits
 * the right answer instead of falling off a table.
 */
export function archiveExt(platform) {
  return platform === 'win32' ? 'zip' : 'tar.gz';
}

/** `wigolo-<semver>-<platform>-<arch>.tar.gz` — the exact §4 spelling, including `win32`/`darwin`. */
export function artifactName(semver, target) {
  const { platform, arch } = splitTarget(target);
  return `wigolo-${semver}-${platform}-${arch}.${archiveExt(platform)}`;
}

/** The executable's path INSIDE the archive's top-level dir. `.exe` only on win32. */
export function binaryRelPath(platform) {
  return platform === 'win32' ? 'bin/wigolo.exe' : 'bin/wigolo';
}

/**
 * `VERSION`, as `key=value` lines.
 *
 * WHY key=value AND NOT JSON. The three named consumers are `install.sh` (POSIX sh), a brew
 * formula, and a packaging script. Two of the three have no JSON parser they can rely on, and
 * §4 G5 says "a consumer can assert it" — an assertion a shell cannot make is not a guarantee.
 * `grep -E '^semver=' VERSION | cut -d= -f2` is the whole reader.
 *
 * `semver` is FIRST so a consumer that gives up and reads line 1 still gets the field the
 * contract is actually about.
 *
 * No build timestamp. It would make two builds of the same commit differ in bytes for a field
 * nothing reads, which costs the ability to diff two artifacts and say "these are the same".
 */
export function versionFile({ semver, target, manifest, toolchain = 'node-sea' }) {
  const { platform, arch } = splitTarget(target);
  const lines = [
    `semver=${semver}`,
    `target=${target}`,
    `platform=${platform}`,
    `arch=${arch}`,
    `toolchain=${toolchain}`,
    `runtime=${manifest.runtime.kind}`,
    `runtimeVersion=${manifest.runtime.version}`,
    `abi=${manifest.runtime.abi}`,
    `napi=${manifest.runtime.napi}`,
    `esbuild=${manifest.toolchain.esbuild}`,
    `postject=${manifest.toolchain.postject}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** Parse a `VERSION` file back into an object — the assertion half of G5, and what tests read. */
export function parseVersionFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const eq = line.indexOf('=');
    if (eq === -1) throw new Error(`VERSION line is not key=value: ${JSON.stringify(line)}`);
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * The `import.meta.url` anchor the bundle pretends to live at, relative to the archive root.
 *
 * Three dist depths have to resolve (spike §2a build-fact 2): `join(here,'..')`,
 * `'../..'` and `'../../..'` all land on a mirrored `package.json`. Anchoring the bundle at
 * `libexec/app/dist/cli/tui/__bundle.cjs` puts those three walks on `dist/cli/`, `dist/` and
 * the app root respectively — the same three depths the npm layout has, which is why no
 * `src/` reader needs to know it is inside a binary.
 *
 * `tui/` rather than `agents/` (the pkg era's choice) for no reason beyond depth: any 4th-level
 * directory works, and this one is not a real dist directory, so a mirrored file can never be
 * confused for a shipped one.
 */
export const APP_ANCHOR_REL = 'libexec/app/dist/cli/tui/__bundle.cjs';

/**
 * The dist depths `package.json` is mirrored at, as paths under `libexec/app/`.
 *
 * ENUMERATIVE ON PURPOSE, and that is the weakness this list has to be read with: a reader
 * that walks FOUR levels up lands above the app root, finds nothing, and — for the
 * `readFileSync`-in-a-`catch` shape at `src/server.ts` — silently answers `0.0.0`.
 * `tests/unit/binary/version-readers.test.ts` is the guard that reds when an eighth site
 * lands at a depth that is not in here.
 */
export const PACKAGE_JSON_MIRRORS = Object.freeze([
  'package.json', // depth 3 walk: join(here, '..','..','..')
  'dist/package.json', // depth 2 walk
  'dist/cli/package.json', // depth 1 walk
]);

/** §7's budget, in bytes. Both halves, because a build can pass one and blow the other. */
export const SIZE_BUDGET = Object.freeze({
  compressedBytes: 200 * 1000 * 1000,
  unpackedBytes: 500 * 1000 * 1000,
});
