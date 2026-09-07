/*
 * Reader and validator for `scripts/binary/runtime.json` — the single runtime/ABI pin.
 *
 * WHY THIS IS A MODULE AND NOT A `JSON.parse` AT THE TOP OF `harvest.mjs`.
 *
 * The pin file is the one input that decides what every downstream slice fetches, injects
 * and verifies. A typo in it does not produce a broken build — it produces a build that
 * quietly harvests the wrong ABI. `better-sqlite3`'s asset name embeds the ABI
 * (`…-node-v127-darwin-arm64.tar.gz`), so `abi: "128"` does not fail loudly, it 404s and
 * looks exactly like a missing upstream prebuild. So the file is validated field by field
 * BEFORE any network call, and every refusal names the field and what it holds.
 *
 * WHAT IS DELIBERATELY NOT IN THE PIN FILE. Package versions. They live in
 * `package-lock.json`, which is exact where `package.json` floats (`sharp ^0.34.5`,
 * `sqlite-vec ^0.1.9`), and duplicating them here would create a second source of truth
 * that a routine `npm update` would silently desynchronise. `lockPath` is the join.
 *
 * FAIL-CLOSED, ALWAYS — the opposite stance from `scripts/prune/*`. A prune that fails
 * open leaves a larger but working install. A harvest that fails open ships a binary
 * missing a native, so every ambiguity here is an error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BINARY_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(BINARY_DIR, '..', '..');
export const RUNTIME_JSON = path.join(BINARY_DIR, 'runtime.json');

/** The ABI kinds the harvest knows how to assert something about. */
export const ABI_KINDS = Object.freeze(['node-abi', 'napi', 'sqlite-extension']);

/**
 * Every `<platform>-<arch>` string the mini-spec 1 matrix contains.
 *
 * Held here as well as in the pin file so that a `targets` array edited to something the
 * tooling has no source mapping for is a validation error rather than a run that resolves
 * zero cells and reports success. `runtime.json` may narrow this set (a target dropping
 * from the ship matrix by spec amendment is an expected event — mini-spec 2's M6 gate);
 * it may not invent a member of it.
 */
export const KNOWN_TARGETS = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
]);

function fail(message) {
  throw new Error(`runtime.json: ${message}`);
}

function requireString(obj, key, where) {
  const value = obj?.[key];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${where}.${key} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Validate a parsed pin document and return it frozen.
 *
 * Pure — no filesystem, no network — so the whole rule set is testable against literals
 * instead of only against the one file that happens to be on disk.
 *
 * @param {unknown} doc parsed JSON
 * @returns {Readonly<object>} the same document, deep-frozen
 */
export function validateManifest(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail(`expected a JSON object, got ${Array.isArray(doc) ? 'an array' : typeof doc}`);
  }

  const runtime = doc.runtime;
  if (runtime === null || typeof runtime !== 'object') fail('missing "runtime" object');
  const kind = requireString(runtime, 'kind', 'runtime');
  if (kind !== 'node') {
    // bun is the recorded re-spike candidate (DR-9's reversal condition), not a value the
    // current tooling can act on. Refusing here beats fetching nodejs.org for a bun pin.
    fail(`runtime.kind is "${kind}"; this tooling implements "node" only (mini-spec DR-9)`);
  }
  const version = requireString(runtime, 'version', 'runtime');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`runtime.version must be a bare x.y.z semver without a leading "v", got "${version}"`);
  }
  const abi = requireString(runtime, 'abi', 'runtime');
  if (!/^\d+$/.test(abi)) fail(`runtime.abi must be a decimal string, got "${abi}"`);
  if (!Number.isInteger(runtime.napi) || runtime.napi < 1) {
    fail(`runtime.napi must be a positive integer (the NAPI level the runtime supports), got ${JSON.stringify(runtime.napi)}`);
  }

  const targets = doc.targets;
  if (!Array.isArray(targets) || targets.length === 0) fail('"targets" must be a non-empty array');
  for (const target of targets) {
    if (!KNOWN_TARGETS.includes(target)) {
      fail(`targets contains "${target}", which is not one of ${KNOWN_TARGETS.join(', ')}`);
    }
  }
  if (new Set(targets).size !== targets.length) fail('"targets" contains a duplicate');

  const shas = doc.runtimeTarballSha256;
  if (shas === null || typeof shas !== 'object') fail('missing "runtimeTarballSha256" object');
  for (const target of targets) {
    const sha = shas[target];
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) {
      // A truncated or absent hash is the shape that ships an unverified runtime.
      fail(`runtimeTarballSha256["${target}"] must be 64 lowercase hex chars, got ${JSON.stringify(sha)}`);
    }
  }

  const natives = doc.natives;
  if (natives === null || typeof natives !== 'object') fail('missing "natives" object');
  const names = Object.keys(natives).filter((k) => !k.startsWith('$'));
  if (names.length === 0) fail('"natives" declares no packages');

  for (const name of names) {
    const spec = natives[name];
    const where = `natives["${name}"]`;
    if (spec === null || typeof spec !== 'object') fail(`${where} must be an object`);
    const lockPath = requireString(spec, 'lockPath', where);
    if (!lockPath.startsWith('node_modules/')) {
      fail(`${where}.lockPath must be a package-lock.json key such as "node_modules/${name}", got "${lockPath}"`);
    }
    const abiKind = requireString(spec, 'abiKind', where);
    if (!ABI_KINDS.includes(abiKind)) {
      fail(`${where}.abiKind is "${abiKind}", expected one of ${ABI_KINDS.join(', ')}`);
    }
    if (typeof spec.optional !== 'boolean') {
      fail(`${where}.optional must be a boolean — it decides whether an absent cell fails the build`);
    }
    const napiVersion = spec.napiVersion;
    if (napiVersion !== null && !(Number.isInteger(napiVersion) && napiVersion >= 1)) {
      fail(`${where}.napiVersion must be a positive integer or null (null = upstream declares none), got ${JSON.stringify(napiVersion)}`);
    }
    if (napiVersion !== null && abiKind !== 'napi') {
      fail(`${where} declares napiVersion ${napiVersion} but abiKind "${abiKind}" — a NAPI level is only meaningful for a NAPI addon`);
    }
    if (napiVersion !== null && napiVersion > runtime.napi) {
      // The one ABI assertion available before a single byte is fetched.
      fail(
        `${where} needs NAPI ${napiVersion} but runtime ${kind} ${version} supports NAPI ${runtime.napi}` +
          ' — this binary cannot load that native'
      );
    }
  }

  return Object.freeze(doc);
}

/**
 * Read and validate the pin file.
 *
 * @param {string} [file] override, for tests and for probing a candidate pin
 */
export function readManifest(file = RUNTIME_JSON) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`runtime.json: cannot read ${file}: ${err?.message ?? err}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`runtime.json: ${file} is not valid JSON: ${err?.message ?? err}`);
  }
  return validateManifest(doc);
}

/** The declared natives, `$`-prefixed documentation keys removed. */
export function nativeNames(manifest) {
  return Object.keys(manifest.natives).filter((k) => !k.startsWith('$'));
}
