/**
 * Native-module load probe for a PACKAGED artifact.
 *
 * WHY it takes an anchor path instead of living inside the app: what has to be proven is that these
 * modules resolve and dlopen the way the packaged main process resolves them. `createRequire(anchor)`
 * reproduces exactly that — point it at `…/app.asar/out/main/index.js` and resolution walks the same
 * `node_modules` chain, lands on a path inside the archive, and hits Electron's asar layer on
 * `process.dlopen`. So we get the packaged code path without shipping a test file in the artifact.
 *
 * The failure this guards against: Electron answers `dlopen` for a `.node` inside an asar by copying
 * THAT ONE FILE to a temp dir. Every module here reaches a sibling shared library by `@rpath`
 * (`libonnxruntime.*.dylib`, `libvips-cpp.*.dylib`) or by an absolute path handed straight to
 * `sqlite3_load_extension`. The lone copied `.node` is stranded from its siblings and the load fails.
 * Keeping each package WHOLE on disk is the only arrangement `@rpath` can resolve — which
 * electron-builder's `smartUnpack` heuristic does by default and the asarUnpack list in
 * `electron-builder.config.ts` pins by name. See that file for which of the two is load-bearing.
 *
 * Usage:  <runtime> native-probe.cjs <anchor-path> [module...]
 *   runtime — the packaged Electron binary under ELECTRON_RUN_AS_NODE, or plain `node` for the
 *             broker's runtime (see the two-runtime split in tests/e2e/packaging.spec.ts).
 *   modules — optional subset; defaults to all four.
 *
 * Prints one line of JSON on stdout and exits non-zero if any probed module failed. Every module is
 * probed independently and nothing short-circuits: one broken glob must not hide the other three.
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createRequire } = require('node:module');

const anchor = process.argv[2];
if (!anchor) {
  process.stderr.write('native-probe: an anchor path inside the packaged app is required\n');
  process.exit(2);
}
const req = createRequire(anchor);

function tmpdb(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wigolo-probe-')), name);
}

const PROBES = {
  // Open a DB and prove FTS5 is compiled in, not merely that the binding loaded. A binding without
  // FTS5 would leave the cache's entire keyword-search path dead while looking healthy.
  'better-sqlite3': () => {
    const Database = req('better-sqlite3');
    const db = new Database(tmpdb('probe.db'));
    db.exec('CREATE VIRTUAL TABLE t USING fts5(body)');
    db.prepare('INSERT INTO t(body) VALUES (?)').run('the quick brown fox');
    const hit = db.prepare("SELECT body FROM t WHERE t MATCH 'brown'").get();
    const binding = req.resolve('better-sqlite3/build/Release/better_sqlite3.node');
    db.close();
    if (!hit || hit.body !== 'the quick brown fox') throw new Error('FTS5 MATCH returned no row');
    return `fts5 match ok; binding=${binding}`;
  },

  // Load the extension and answer a real KNN query. Loading `vec0.dylib` is the part an archive
  // breaks; the query is what proves the loaded extension actually works.
  'sqlite-vec': () => {
    const Database = req('better-sqlite3');
    const sqliteVec = req('sqlite-vec');
    const loadable = sqliteVec.getLoadablePath();
    const db = new Database(tmpdb('vec.db'));
    db.loadExtension(loadable);
    db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[4])');
    // Let vec0 assign rowids (1 then 2) — it rejects a bound JS number for an explicit rowid.
    const ins = db.prepare('INSERT INTO v(embedding) VALUES (?)');
    ins.run(Buffer.from(new Float32Array([1, 0, 0, 0]).buffer));
    ins.run(Buffer.from(new Float32Array([0, 1, 0, 0]).buffer));
    const row = db
      .prepare('SELECT rowid, distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 1')
      .get(Buffer.from(new Float32Array([0.9, 0.1, 0, 0]).buffer));
    db.close();
    if (!row || row.rowid !== 1) throw new Error(`KNN returned ${JSON.stringify(row)}, expected rowid 1`);
    return `knn rowid=${row.rowid} distance=${row.distance.toFixed(4)}; loadable=${loadable}`;
  },

  // The embedding backend. Its binding resolves @rpath/libonnxruntime.*.dylib.
  'onnxruntime-node': () => {
    const ort = req('onnxruntime-node');
    if (typeof ort.InferenceSession?.create !== 'function') throw new Error('InferenceSession.create missing');
    return `InferenceSession present; version=${req('onnxruntime-node/package.json').version}`;
  },

  // The screenshot/thumbnail pipeline. Its binding resolves @rpath/libvips-cpp.*.dylib, which lives
  // in a DIFFERENT npm package than the binding itself.
  sharp: () => {
    const sharp = req('sharp');
    if (!sharp.versions?.vips) throw new Error('sharp.versions.vips missing — libvips did not load');
    return `libvips=${sharp.versions.vips}`;
  },
};

const selected = process.argv.length > 3 ? process.argv.slice(3) : Object.keys(PROBES);
const modules = {};
for (const name of selected) {
  const fn = PROBES[name];
  if (!fn) {
    modules[name] = { ok: false, detail: `native-probe: unknown module '${name}'` };
    continue;
  }
  try {
    modules[name] = { ok: true, detail: fn() };
  } catch (err) {
    const code = err && err.code ? `[${err.code}] ` : '';
    modules[name] = { ok: false, detail: `${code}${err && err.message ? err.message : String(err)}` };
  }
}

process.stdout.write(
  `${JSON.stringify({
    anchor,
    anchorInAsar: anchor.includes('.asar') && !anchor.includes('.asar.unpacked'),
    execPath: process.execPath,
    modulesAbi: process.versions.modules,
    electron: process.versions.electron ?? null,
    modules,
  })}\n`,
);

process.exit(Object.values(modules).every((m) => m.ok) ? 0 : 1);
