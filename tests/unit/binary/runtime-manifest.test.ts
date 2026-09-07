import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { validateManifest, readManifest, nativeNames, KNOWN_TARGETS, ABI_KINDS, RUNTIME_JSON } from '../../../scripts/binary/manifest.mjs';

/*
 * WHY these tests exist.
 *
 * `scripts/binary/runtime.json` is the single pin: one file decides which Node the binary
 * embeds, which ABI its natives must be built for, and which targets ship. A typo in it does
 * not produce a broken build — it produces a build that harvests the WRONG ABI and looks
 * exactly like a platform upstream forgot to publish. `better-sqlite3`'s asset name carries
 * the ABI (`…-node-v127-darwin-arm64.tar.gz`), so `abi: "128"` 404s; `abi: "12 7"` builds a
 * URL that 404s; a truncated sha256 verifies nothing and reads as verified.
 *
 * So every field the harvest acts on is validated before a byte is fetched, and every rule
 * below names the shape it refuses rather than asserting that valid input is valid.
 */

/** A pin document that passes, used as the base every negative arm mutates by one field. */
function goodDoc(): Record<string, unknown> {
  return {
    runtime: { kind: 'node', version: '22.14.0', abi: '127', napi: 10 },
    targets: ['darwin-arm64', 'linux-x64'],
    runtimeTarballSha256: {
      'darwin-arm64': 'e9404633bc02a5162c5c573b1e2490f5fb44648345d64a958b17e325729a5e42',
      'linux-x64': '9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2',
    },
    natives: {
      'better-sqlite3': { lockPath: 'node_modules/better-sqlite3', abiKind: 'node-abi', napiVersion: null, optional: false },
    },
  };
}

/** Mutate one path of the good doc; everything else stays valid so the arm is about one rule. */
function withRuntime(patch: Record<string, unknown>): Record<string, unknown> {
  const doc = goodDoc();
  doc.runtime = { ...(doc.runtime as object), ...patch };
  return doc;
}

describe('the pin file on disk', () => {
  it('validates, and pins the facts the BIN-1 spike measured', () => {
    const manifest = readManifest();
    // These five numbers are the spike's result (mini-spec §2a). A silent edit to any of them
    // changes what every downstream slice fetches and injects, so they are asserted by value.
    expect(manifest.runtime.kind).toBe('node');
    expect(manifest.runtime.version).toBe('22.14.0');
    expect(manifest.runtime.abi).toBe('127');
    expect(manifest.runtime.napi).toBe(10);
    expect(manifest.toolchain.seaFuse).toBe('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
  });

  it('pins all five mini-spec §1 targets, each with a full runtime digest', () => {
    const manifest = readManifest();
    expect([...manifest.targets].sort()).toEqual([...KNOWN_TARGETS].sort());
    for (const target of manifest.targets) {
      expect(manifest.runtimeTarballSha256[target]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('declares the whole §1 native inventory, with the two optionals marked optional', () => {
    const manifest = readManifest();
    expect(nativeNames(manifest).sort()).toEqual(
      ['@napi-rs/keyring', 'better-sqlite3', 'onnxruntime-node', 'sharp', 'sqlite-vec', 'wreq-js'].sort()
    );
    // The degrade-cleanly rule is a per-native property, and getting it backwards either fails
    // a build over a keychain tier or ships a binary silently missing a database driver.
    expect(manifest.natives['@napi-rs/keyring'].optional).toBe(true);
    expect(manifest.natives['wreq-js'].optional).toBe(true);
    for (const name of ['better-sqlite3', 'sqlite-vec', 'onnxruntime-node', 'sharp']) {
      expect(manifest.natives[name].optional).toBe(false);
    }
  });

  it('carries no package versions — the lockfile is the only version source', () => {
    // A version duplicated here would desynchronise on the next `npm update` and the drift
    // assertion would then be comparing two copies of the same stale number.
    const raw = readFileSync(RUNTIME_JSON, 'utf8');
    const doc = JSON.parse(raw);
    for (const [name, spec] of Object.entries<Record<string, unknown>>(doc.natives)) {
      if (name.startsWith('$')) continue;
      expect(Object.keys(spec)).not.toContain('version');
    }
  });

  it('names every native by a lockfile key that package-lock.json actually has', () => {
    const manifest = readManifest();
    const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));
    for (const name of nativeNames(manifest)) {
      expect(lock.packages[manifest.natives[name].lockPath], `${name} lockPath`).toBeDefined();
    }
  });
});

describe('validateManifest refuses a pin it cannot act on', () => {
  it('accepts the good document unchanged', () => {
    expect(() => validateManifest(goodDoc())).not.toThrow();
  });

  it.each([
    ['an array', []],
    ['a string', 'node'],
    ['null', null],
  ])('refuses %s at the top level', (_label, doc) => {
    expect(() => validateManifest(doc)).toThrow(/expected a JSON object/);
  });

  it('refuses a bun pin, naming the ruling that makes node the only implemented runtime', () => {
    // bun is DR-9's recorded RE-spike candidate, not a value this tooling can act on. Without
    // this the run would fetch nodejs.org for a pin that says bun.
    expect(() => validateManifest(withRuntime({ kind: 'bun' }))).toThrow(/runtime.kind is "bun".*DR-9/s);
  });

  it('refuses a version carrying the leading v the download URL adds itself', () => {
    expect(() => validateManifest(withRuntime({ version: 'v22.14.0' }))).toThrow(/without a leading "v"/);
  });

  it('refuses a non-decimal ABI, the value that becomes a 404 in the asset name', () => {
    for (const abi of ['12 7', 'v127', '', '127.0']) {
      expect(() => validateManifest(withRuntime({ abi })), `abi ${JSON.stringify(abi)}`).toThrow(/runtime.abi/);
    }
  });

  it('refuses a missing or non-integer NAPI level', () => {
    expect(() => validateManifest(withRuntime({ napi: undefined }))).toThrow(/runtime.napi/);
    expect(() => validateManifest(withRuntime({ napi: '10' }))).toThrow(/runtime.napi/);
    expect(() => validateManifest(withRuntime({ napi: 0 }))).toThrow(/runtime.napi/);
  });

  it('refuses a target with no known source mapping, listing the ones there are', () => {
    const doc = goodDoc();
    doc.targets = ['darwin-arm64', 'linux-musl-x64'];
    // musl is out of the matrix by mini-spec §1; a target nothing maps would otherwise resolve
    // zero cells and the run would report success over an empty staging dir.
    expect(() => validateManifest(doc)).toThrow(/linux-musl-x64.*darwin-arm64/s);
  });

  it('refuses a duplicated target', () => {
    const doc = goodDoc();
    doc.targets = ['darwin-arm64', 'darwin-arm64'];
    expect(() => validateManifest(doc)).toThrow(/duplicate/);
  });

  it('refuses a truncated runtime digest — the shape that reads as verified and verifies nothing', () => {
    const doc = goodDoc();
    (doc.runtimeTarballSha256 as Record<string, string>)['darwin-arm64'] = 'e9404633bc02…5729a5e42';
    expect(() => validateManifest(doc)).toThrow(/64 lowercase hex/);
  });

  it('refuses a target that ships with no runtime digest at all', () => {
    const doc = goodDoc();
    delete (doc.runtimeTarballSha256 as Record<string, string>)['linux-x64'];
    expect(() => validateManifest(doc)).toThrow(/runtimeTarballSha256\["linux-x64"\]/);
  });

  it('refuses an uppercase digest, which no comparison in the pipeline would match', () => {
    const doc = goodDoc();
    (doc.runtimeTarballSha256 as Record<string, string>)['darwin-arm64'] =
      'E9404633BC02A5162C5C573B1E2490F5FB44648345D64A958B17E325729A5E42';
    expect(() => validateManifest(doc)).toThrow(/64 lowercase hex/);
  });

  it('refuses a lockPath that is not a package-lock.json key', () => {
    const doc = goodDoc();
    (doc.natives as Record<string, Record<string, unknown>>)['better-sqlite3'].lockPath = 'better-sqlite3';
    expect(() => validateManifest(doc)).toThrow(/lockPath must be a package-lock.json key/);
  });

  it.each(ABI_KINDS)('accepts abiKind %s', (kind: string) => {
    const doc = goodDoc();
    const spec = (doc.natives as Record<string, Record<string, unknown>>)['better-sqlite3'];
    spec.abiKind = kind;
    expect(() => validateManifest(doc)).not.toThrow();
  });

  it('refuses an abiKind nothing knows how to assert against', () => {
    const doc = goodDoc();
    (doc.natives as Record<string, Record<string, unknown>>)['better-sqlite3'].abiKind = 'wasm';
    expect(() => validateManifest(doc)).toThrow(/abiKind is "wasm"/);
  });

  it('refuses a non-boolean optional, the field that decides refuse-vs-degrade', () => {
    const doc = goodDoc();
    (doc.natives as Record<string, Record<string, unknown>>)['better-sqlite3'].optional = 'false';
    expect(() => validateManifest(doc)).toThrow(/optional must be a boolean/);
  });

  it('refuses a NAPI level on a native that is not a NAPI addon', () => {
    const doc = goodDoc();
    const spec = (doc.natives as Record<string, Record<string, unknown>>)['better-sqlite3'];
    spec.napiVersion = 3;
    expect(() => validateManifest(doc)).toThrow(/abiKind "node-abi" — a NAPI level is only meaningful/);
  });

  it('refuses a native needing a NAPI level the pinned runtime cannot provide', () => {
    const doc = goodDoc();
    (doc.natives as Record<string, Record<string, unknown>>)['better-sqlite3'] = {
      lockPath: 'node_modules/better-sqlite3',
      abiKind: 'napi',
      napiVersion: 11,
      optional: false,
    };
    // The one ABI assertion available with zero bytes fetched: node 22.14.0 supports NAPI 10.
    expect(() => validateManifest(doc)).toThrow(/needs NAPI 11 but runtime node 22.14.0 supports NAPI 10/);
  });

  it('accepts a NAPI level the runtime does provide', () => {
    const doc = goodDoc();
    (doc.natives as Record<string, Record<string, unknown>>)['better-sqlite3'] = {
      lockPath: 'node_modules/better-sqlite3',
      abiKind: 'napi',
      napiVersion: 10,
      optional: false,
    };
    expect(() => validateManifest(doc)).not.toThrow();
  });

  it('ignores $-prefixed documentation keys among the natives', () => {
    const doc = goodDoc();
    (doc.natives as Record<string, unknown>).$doc = 'prose, not a package';
    expect(() => validateManifest(doc)).not.toThrow();
    expect(nativeNames(validateManifest(doc))).toEqual(['better-sqlite3']);
  });

  it('refuses a natives block with nothing in it but prose', () => {
    const doc = goodDoc();
    doc.natives = { $doc: 'prose' };
    expect(() => validateManifest(doc)).toThrow(/declares no packages/);
  });
});

describe('readManifest', () => {
  it('names the file it could not read', () => {
    expect(() => readManifest('/nonexistent/runtime.json')).toThrow(/cannot read \/nonexistent\/runtime.json/);
  });

  it('names the file that is not valid JSON', () => {
    expect(() => readManifest(join(process.cwd(), 'package.json.does-not-exist'))).toThrow(/cannot read/);
  });
});
