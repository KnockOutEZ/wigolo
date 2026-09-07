import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { harvestTarget, describeTarget, checkIntegrity } from '../../../scripts/binary/harvest.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { versionDrift } from '../../../scripts/binary/cells.mjs';

/*
 * WHY these tests exist, and why every one of them is offline.
 *
 * The harvest's whole contract is what it does when something is WRONG: refuse and name the
 * cell (DR-3, no source-build fallback exists), or — for the two optionals — record the
 * absence and carry on. Those paths are unreachable from a green live run, so they are driven
 * here with a fake registry: an injected `download` that returns tarballs this file builds,
 * and can 404, or hand back the wrong bytes, or a tarball missing the file we asked for.
 *
 * A live arm exists separately (`harvest-live.test.ts`, opt-in) because it measures upstream,
 * not us. `tests/net-fence.ts` would record any socket this file opened, which is the point:
 * these arms must be reproducible on a machine with no network at all.
 */

const REAL_LOCK = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));

let work: string;

beforeAll(() => {
  // Never inside the repo: the tool's own hard guards stop dead on a delete under the working
  // tree, and an unattended pane cannot answer a confirmation.
  work = mkdtempSync(join(tmpdir(), 'wigolo-harvest-test-'));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Build a `.tar.gz` from a {relative path -> contents} map and return its bytes. */
function tarball(files: Record<string, string | Buffer>): Buffer {
  const root = mkdtempSync(join(work, 'tar-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  const out = join(root, 'out.tar.gz');
  execFileSync('tar', ['-czf', 'out.tar.gz', ...Object.keys(files)], { cwd: root });
  return readFileSync(out);
}

/** An npm tarball: everything under `package/`, with a package.json carrying `version`. */
function npmTarball(pkg: string, version: string, extra: Record<string, string | Buffer> = {}): Buffer {
  const files: Record<string, string | Buffer> = {
    'package/package.json': JSON.stringify({ name: pkg, version }),
  };
  for (const [rel, contents] of Object.entries(extra)) files[`package/${rel}`] = contents;
  return tarball(files);
}

function sha512(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/*
 * A two-cell pin: one non-optional npm cell and one optional npm cell. Small on purpose —
 * every arm below is about ONE behaviour, and the real six-native inventory is asserted by
 * `prebuild-cells.test.ts` and by the live arm.
 */
const PIN = Object.freeze({
  runtime: { kind: 'node', version: '22.14.0', abi: '127', napi: 10 },
  targets: ['darwin-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'win32-x64'],
  runtimeTarballSha256: {},
  natives: {
    'sqlite-vec': { lockPath: 'node_modules/sqlite-vec', abiKind: 'sqlite-extension', napiVersion: null, optional: false },
    'wreq-js': { lockPath: 'node_modules/wreq-js', abiKind: 'napi', napiVersion: null, optional: true },
  },
});

const VEC_VERSION = '0.1.9';
const WREQ_VERSION = '2.3.1';

/** A lockfile with exactly the two packages the pin needs, and matching integrity hashes. */
function fixtureLock(bytes: { vec: Buffer; wreq: Buffer }, overrides: Record<string, unknown> = {}) {
  const lock = {
    packages: {
      'node_modules/sqlite-vec-darwin-arm64': {
        version: VEC_VERSION,
        resolved: 'https://registry.example.invalid/sqlite-vec-darwin-arm64.tgz',
        integrity: sha512(bytes.vec),
      },
      'node_modules/wreq-js': {
        version: WREQ_VERSION,
        resolved: 'https://registry.example.invalid/wreq-js.tgz',
        integrity: sha512(bytes.wreq),
      },
    },
  };
  return { ...lock, ...overrides };
}

interface Downloads {
  [url: string]: Buffer | Error;
}

function downloader(map: Downloads) {
  return async (url: string) => {
    const hit = map[url];
    if (hit === undefined) throw new Error(`GET ${url} -> HTTP 404 Not Found`);
    if (hit instanceof Error) throw hit;
    return hit;
  };
}

/** The happy-path fixture: both cells fetchable, both carrying a loadable object. */
function happyFixture() {
  const vec = npmTarball('sqlite-vec-darwin-arm64', VEC_VERSION, { 'vec0.dylib': 'fake mach-o' });
  const wreq = npmTarball('wreq-js', WREQ_VERSION, { 'rust/wreq-js.darwin-arm64.node': 'fake addon' });
  const lock = fixtureLock({ vec, wreq });
  const download = downloader({
    'https://registry.example.invalid/sqlite-vec-darwin-arm64.tgz': vec,
    'https://registry.example.invalid/wreq-js.tgz': wreq,
  });
  return { vec, wreq, lock, download };
}

function stageDir(name: string): string {
  const dir = join(work, `stage-${name}`);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

describe('a complete harvest', () => {
  it('stages every cell, records each payload with its sha256, and writes the manifest', async () => {
    const { lock, download } = happyFixture();
    const stageRoot = stageDir('happy');
    const doc = await harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot, download });

    expect(doc.cells.map((c: { id: string; status: string }) => [c.id, c.status])).toEqual([
      [`sqlite-vec-darwin-arm64@${VEC_VERSION}/darwin-arm64`, 'staged'],
      [`wreq-js@${WREQ_VERSION}/darwin-arm64`, 'staged'],
    ]);
    expect(doc.absent).toEqual([]);

    // The bytes land at the sidecar path the binary will resolve relative to its own realpath.
    expect(existsSync(join(stageRoot, 'libexec/node_modules/sqlite-vec-darwin-arm64/vec0.dylib'))).toBe(true);
    expect(existsSync(join(stageRoot, 'libexec/node_modules/wreq-js/rust/wreq-js.darwin-arm64.node'))).toBe(true);

    const payload = doc.cells[0].payload;
    expect(payload).toHaveLength(1);
    expect(payload[0].path).toBe('vec0.dylib');
    expect(payload[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload[0].bytes).toBeGreaterThan(0);

    const written = JSON.parse(readFileSync(join(stageRoot, 'harvest-manifest.json'), 'utf8'));
    expect(written.target).toBe('darwin-arm64');
    expect(written.runtime.abi).toBe('127');
  });

  it('slices one file out of a package that ships every target', async () => {
    // wreq-js carries seven .node files; staging all of them would put six unloadable
    // binaries — and ~40 MiB — into every artifact.
    const vec = npmTarball('sqlite-vec-darwin-arm64', VEC_VERSION, { 'vec0.dylib': 'x' });
    const wreq = npmTarball('wreq-js', WREQ_VERSION, {
      'rust/wreq-js.darwin-arm64.node': 'the one we want',
      'rust/wreq-js.linux-x64-gnu.node': 'foreign',
      'rust/wreq-js.win32-x64-msvc.node': 'foreign',
    });
    const lock = fixtureLock({ vec, wreq });
    const download = downloader({
      'https://registry.example.invalid/sqlite-vec-darwin-arm64.tgz': vec,
      'https://registry.example.invalid/wreq-js.tgz': wreq,
    });
    const stageRoot = stageDir('slice');
    const doc = await harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot, download });

    const staged = doc.cells[1].payload.map((p: { path: string }) => p.path);
    expect(staged).toEqual(['wreq-js.darwin-arm64.node']);
    expect(existsSync(join(stageRoot, 'libexec/node_modules/wreq-js/rust/wreq-js.linux-x64-gnu.node'))).toBe(false);
  });

  it('records integrity as VERIFIED only where an upstream digest existed', async () => {
    const { lock, download } = happyFixture();
    const doc = await harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('integrity'), download });
    for (const cell of doc.cells) {
      expect(cell.source.integrityVerified, cell.id).toBe(true);
    }
  });
});

describe('refuse, don’t compile — a non-optional cell that cannot be completed fails the run', () => {
  it('names the cell and says no source-build fallback exists, when upstream 404s', async () => {
    const { lock } = happyFixture();
    // Nothing registered for the vec URL: the shape of "upstream published no prebuild".
    const download = downloader({});
    await expect(
      harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('404'), download })
    ).rejects.toThrow(/REFUSED cell sqlite-vec-darwin-arm64@0.1.9\/darwin-arm64 — sqlite-vec for darwin-arm64/);
    await expect(
      harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('404b'), download })
    ).rejects.toThrow(/no source-build fallback exists in this pipeline \(mini-spec DR-3\)/);
  });

  it('names the cell when the lockfile does not describe it at all', async () => {
    const { lock, download } = happyFixture();
    delete (lock.packages as Record<string, unknown>)['node_modules/sqlite-vec-darwin-arm64'];
    await expect(
      harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('nolock'), download })
    ).rejects.toThrow(/REFUSED cell sqlite-vec-darwin-arm64\/darwin-arm64.*no "node_modules\/sqlite-vec-darwin-arm64" entry/s);
  });

  it('refuses a checksum mismatch even on an OPTIONAL cell — wrong bytes are not absent bytes', async () => {
    // The dangerous shape: degrading a corrupted or substituted download to "absent" would
    // turn a supply-chain signal into a missing feature nobody investigates.
    const vec = npmTarball('sqlite-vec-darwin-arm64', VEC_VERSION, { 'vec0.dylib': 'x' });
    const wreq = npmTarball('wreq-js', WREQ_VERSION, { 'rust/wreq-js.darwin-arm64.node': 'x' });
    const lock = fixtureLock({ vec, wreq });
    const download = downloader({
      'https://registry.example.invalid/sqlite-vec-darwin-arm64.tgz': vec,
      'https://registry.example.invalid/wreq-js.tgz': npmTarball('wreq-js', WREQ_VERSION, { 'rust/wreq-js.darwin-arm64.node': 'DIFFERENT' }),
    });
    await expect(
      harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('badsum'), download })
    ).rejects.toThrow(/REFUSED cell wreq-js@2.3.1\/darwin-arm64.*integrity mismatch — lockfile says sha512-.*downloaded bytes are sha512-/s);
  });

  it('refuses a tarball whose own package.json version is not the pinned one', async () => {
    const vec = npmTarball('sqlite-vec-darwin-arm64', '0.2.0', { 'vec0.dylib': 'x' });
    const wreq = npmTarball('wreq-js', WREQ_VERSION, { 'rust/wreq-js.darwin-arm64.node': 'x' });
    const lock = fixtureLock({ vec, wreq });
    const download = downloader({
      'https://registry.example.invalid/sqlite-vec-darwin-arm64.tgz': vec,
      'https://registry.example.invalid/wreq-js.tgz': wreq,
    });
    await expect(
      harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('drift-payload'), download })
    ).rejects.toThrow(/version drift — package-lock.json pins 0.1.9, the downloaded tarball is 0.2.0/);
  });

  it('refuses a staged cell that contains no loadable object', async () => {
    // A wrong extract path, or an upstream repackaging, stages an empty-of-natives directory.
    // Without this the run reports a complete artifact that cannot open a database.
    const vec = npmTarball('sqlite-vec-darwin-arm64', VEC_VERSION, { 'README.md': 'no binary here' });
    const wreq = npmTarball('wreq-js', WREQ_VERSION, { 'rust/wreq-js.darwin-arm64.node': 'x' });
    const lock = fixtureLock({ vec, wreq });
    const download = downloader({
      'https://registry.example.invalid/sqlite-vec-darwin-arm64.tgz': vec,
      'https://registry.example.invalid/wreq-js.tgz': wreq,
    });
    await expect(
      harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('nopayload'), download })
    ).rejects.toThrow(/contains no loadable object \(\.node\/\.dylib\/\.so\/\.dll\)/);
  });

  it('accepts a versioned .so, which the payload pattern must not miss', async () => {
    // libonnxruntime.so.1.21.0 is exactly the shape a naive `.so` suffix test skips, and
    // skipping it would refuse a perfectly good linux cell.
    const vec = npmTarball('sqlite-vec-darwin-arm64', VEC_VERSION, { 'libvec.so.1.21.0': 'x' });
    const wreq = npmTarball('wreq-js', WREQ_VERSION, { 'rust/wreq-js.darwin-arm64.node': 'x' });
    const lock = fixtureLock({ vec, wreq });
    const download = downloader({
      'https://registry.example.invalid/sqlite-vec-darwin-arm64.tgz': vec,
      'https://registry.example.invalid/wreq-js.tgz': wreq,
    });
    const doc = await harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('sover'), download });
    expect(doc.cells[0].payload.map((p: { path: string }) => p.path)).toEqual(['libvec.so.1.21.0']);
  });
});

describe('optionals degrade cleanly, and the manifest records the absence', () => {
  it('records an optional cell upstream does not publish, and still succeeds', async () => {
    const { lock } = happyFixture();
    const vec = npmTarball('sqlite-vec-darwin-arm64', VEC_VERSION, { 'vec0.dylib': 'x' });
    (lock.packages as Record<string, { integrity: string }>)['node_modules/sqlite-vec-darwin-arm64'].integrity = sha512(vec);
    const download = downloader({ 'https://registry.example.invalid/sqlite-vec-darwin-arm64.tgz': vec });

    const stageRoot = stageDir('optional-404');
    const doc = await harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot, download });

    expect(doc.cells[1].status).toBe('absent');
    expect(doc.cells[1].absence.reason).toMatch(/HTTP 404 Not Found/);
    // The absence is a top-level field, so a build cannot lose the TLS-impersonation tier
    // without the manifest saying which native went missing and why.
    expect(doc.absent).toEqual([
      { id: `wreq-js@${WREQ_VERSION}/darwin-arm64`, native: 'wreq-js', reason: expect.stringMatching(/404/) },
    ]);
    expect(existsSync(join(stageRoot, 'libexec/node_modules/wreq-js'))).toBe(false);
    // The non-optional cell beside it still staged — degrading one must not skip the rest.
    expect(doc.cells[0].status).toBe('staged');
  });

  it('records an optional cell the lockfile omits for this platform', async () => {
    const { lock, download } = happyFixture();
    delete (lock.packages as Record<string, unknown>)['node_modules/wreq-js'];
    const doc = await harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('optional-nolock'), download });
    expect(doc.absent[0].reason).toMatch(/no "node_modules\/wreq-js" entry in package-lock.json/);
  });

  it('records an optional cell whose artifact lacks the file we slice', async () => {
    const vec = npmTarball('sqlite-vec-darwin-arm64', VEC_VERSION, { 'vec0.dylib': 'x' });
    const wreq = npmTarball('wreq-js', WREQ_VERSION, { 'rust/wreq-js.linux-x64-gnu.node': 'wrong target only' });
    const lock = fixtureLock({ vec, wreq });
    const download = downloader({
      'https://registry.example.invalid/sqlite-vec-darwin-arm64.tgz': vec,
      'https://registry.example.invalid/wreq-js.tgz': wreq,
    });
    const doc = await harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('optional-noslice'), download });
    expect(doc.absent[0].reason).toBe('artifact contains no rust/wreq-js.darwin-arm64.node');
  });
});

describe('drift across runs — the manifest re-checked against a bumped lockfile', () => {
  it('goes red when the lockfile moves under a staging dir that was already harvested', async () => {
    const { lock, download } = happyFixture();
    const doc = await harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('drift'), download });
    expect(versionDrift(doc, lock)).toEqual([]);

    // The bump a routine `npm update` performs. The staged natives are now for the previous
    // version, and DR-3 exists precisely so that ships as a red build rather than an artifact.
    const bumped = structuredClone(lock);
    (bumped.packages as Record<string, { version: string }>)['node_modules/sqlite-vec-darwin-arm64'].version = '0.2.0';
    expect(versionDrift(doc, bumped)).toEqual([
      'sqlite-vec-darwin-arm64: harvested 0.1.9, package-lock.json says 0.2.0',
    ]);
  });

  it('ignores an absent optional, whose recorded version describes no staged bytes', async () => {
    const { lock } = happyFixture();
    const vec = npmTarball('sqlite-vec-darwin-arm64', VEC_VERSION, { 'vec0.dylib': 'x' });
    (lock.packages as Record<string, { integrity: string }>)['node_modules/sqlite-vec-darwin-arm64'].integrity = sha512(vec);
    const download = downloader({ 'https://registry.example.invalid/sqlite-vec-darwin-arm64.tgz': vec });
    const doc = await harvestTarget({ manifest: PIN, lock, target: 'darwin-arm64', stageRoot: stageDir('drift-absent'), download });
    // It DOES keep the version it attempted — that is useful provenance — so the drift check
    // has to skip it by STATUS. Reading it as a drift candidate would fail the build over a
    // native the artifact never contained, i.e. a false red on the degrade path itself.
    expect(doc.cells[1].status).toBe('absent');
    expect(doc.cells[1].version).toBe(WREQ_VERSION);
    const bumped = structuredClone(lock);
    (bumped.packages as Record<string, { version: string }>)['node_modules/wreq-js'].version = '9.9.9';
    expect(versionDrift(doc, bumped)).toEqual([]);
  });
});

describe('checkIntegrity', () => {
  it('accepts the lockfile digest for the exact bytes', () => {
    const bytes = Buffer.from('artifact');
    expect(checkIntegrity(bytes, sha512(bytes)).ok).toBe(true);
  });

  it('rejects one flipped byte and reports both digests', () => {
    const bytes = Buffer.from('artifact');
    const result = checkIntegrity(Buffer.from('artifacts'), sha512(bytes));
    expect(result.ok).toBe(false);
    expect(result.expected).not.toBe(result.actual);
    expect(result.actual).toMatch(/^sha512-/);
  });
});

describe('describeTarget answers "does every target resolve?" with no network', () => {
  it('reports the real six-native inventory for every pinned target', () => {
    // The offline half of the acceptance criterion: --resolve-only over all five targets.
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'scripts/binary/runtime.json'), 'utf8'));
    for (const target of manifest.targets) {
      const rows = describeTarget({ manifest, lock: REAL_LOCK, target });
      expect(rows.filter((r: { unresolvable: string | null; optional: boolean }) => r.unresolvable && !r.optional), target).toEqual([]);
      expect(rows.length, target).toBeGreaterThanOrEqual(6);
    }
  });
});
