/**
 * DB-broker boot probe for a PACKAGED artifact.
 *
 * Companion to `native-probe.cjs`, and it answers a different question. native-probe asks "can these
 * native modules be dlopen'd from the packaged tree". This asks the question that actually failed in
 * production: **does the broker child process start, and can data go through it and come back**.
 *
 * The broker is spawned by the Electron main as a PLAIN-NODE child (spec §13.7 — the main must never
 * load a native module). Plain Node has no asar layer: the archive is a virtual filesystem Electron
 * patches into its own `fs` and nothing else in the world can see. So the resolution ANCHOR decides
 * everything, and that is why this probe takes it as an argument instead of computing it:
 *
 *   …/app.asar/out/main/index.js            the pre-fix anchor. Resolves fine for the Electron main,
 *                                           names a file the child cannot open. THE BUG.
 *   …/app.asar.unpacked/out/main/index.js   the fixed anchor. Synthetic — `out/**` is never unpacked,
 *                                           so this file does not exist — but `createRequire` only
 *                                           walks `node_modules` upward from it and never stats it.
 *
 * Usage:  <runtime> broker-probe.cjs <anchor-path> <data-dir> [--skip-db-inspect]
 *   runtime — plain `node` for the full run, or the packaged Electron binary under
 *             ELECTRON_RUN_AS_NODE to reproduce the HOST's resolution exactly (Electron resolves
 *             through the asar layer; plain Node cannot). The broker child is always spawned on plain
 *             `node` regardless, because that is what `broker-client.ts` does — it explicitly refuses
 *             `process.execPath` under Electron, since better-sqlite3 12.9.0 ships no Electron build.
 *   --skip-db-inspect — omit the FTS5/vec stages, which open the broker's DB in THIS process. Required
 *             for an Electron-hosted run: the engine is Node-ABI 127 and Electron is 148, so the
 *             inspection would fail for an ABI reason that says nothing about the broker.
 *
 * Prints one line of JSON on stdout and exits non-zero if any stage failed. Stages are cumulative and
 * the first failure stops the run — a broker that never boots has nothing to round-trip.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const anchor = process.argv[2];
const dataDir = process.argv[3];
const skipDbInspect = process.argv.includes('--skip-db-inspect');
if (!anchor || !dataDir) {
  process.stderr.write('broker-probe: <anchor-path> <data-dir> are both required\n');
  process.exit(2);
}
/** Always plain Node — see the runtime note above. Never `process.execPath`. */
const BROKER_RUNTIME = 'node';

const BOOT_TIMEOUT_MS = 180_000;
const CALL_TIMEOUT_MS = 60_000;
const SESSION_ID = `probe-${Date.now()}`;
// A token no other row can contain, so the FTS5 MATCH below cannot pass on somebody else's data.
const SENTINEL = `zqxbroker${Date.now().toString(36)}`;

const result = {
  anchor,
  anchorInAsar: anchor.includes('.asar') && !anchor.includes('.asar.unpacked'),
  execPath: process.execPath,
  modulesAbi: process.versions.modules,
  electron: process.versions.electron ?? null,
  stages: {},
  brokerStderrTail: '',
};

let reported = false;
function finish(code) {
  if (reported) return;
  reported = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(code);
}

/**
 * A probe that exits silently is worse than one that fails: the caller sees exit 0 and no JSON, and
 * has to guess. This fired for real during development — the child died instantly on an in-archive
 * path, nothing rejected the boot promise, the only remaining timer was unref'd, and the event loop
 * simply drained. Never again: whatever drains the loop, the JSON gets written.
 */
process.on('exit', () => {
  if (reported) return;
  reported = true;
  result.stages.probe = { ok: false, detail: 'the probe exited without reaching a verdict' };
  process.stdout.write(`${JSON.stringify(result)}\n`);
});

function fail(stage, detail) {
  result.stages[stage] = { ok: false, detail: String(detail && detail.message ? detail.message : detail) };
  finish(1);
}

function pass(stage, detail) {
  result.stages[stage] = { ok: true, detail: String(detail) };
}

async function main() {
  // --- resolve -------------------------------------------------------------------------------
  let brokerPath;
  try {
    brokerPath = createRequire(anchor).resolve('wigolo/studio-db-broker');
  } catch (err) {
    return fail('resolve', err);
  }
  result.brokerPath = brokerPath;
  // The whole defect in one assertion: resolution SUCCEEDING is not the property that matters. A path
  // inside the archive resolves and is still unopenable by this process.
  if (!fs.existsSync(brokerPath)) return fail('resolve', `resolved to ${brokerPath}, which does not exist on disk`);
  pass('resolve', brokerPath);

  // --- containment ---------------------------------------------------------------------------
  // MEASURED, not anticipated: with the unpack glob dropped, resolution did not fail. It walked up out
  // of the .app bundle entirely and found the DEVELOPER'S workspace copy of wigolo, then booted a
  // broker, round-tripped a capture and reported six green stages — a completely vacuous pass for an
  // artifact that would be dead on any machine but this one. Every stage below is worthless without
  // this check, so it comes first.
  const archiveAt = anchor.indexOf('.asar');
  if (archiveAt >= 0) {
    const bundlePrefix = anchor.slice(0, archiveAt);
    if (!brokerPath.startsWith(bundlePrefix)) {
      return fail('containment', `resolved OUTSIDE the artifact: ${brokerPath} is not under ${bundlePrefix}*`);
    }
    pass('containment', `inside the artifact (${bundlePrefix}*)`);
  }

  // --- spawn + ready -------------------------------------------------------------------------
  const child = spawn(BROKER_RUNTIME, [brokerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, WIGOLO_STUDIO_BROKER_MAIN: '1', WIGOLO_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: undefined },
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    stderr += c;
    result.brokerStderrTail = stderr.slice(-4000);
  });

  const pending = new Map();
  let readyResolve;
  let readyReject;
  let exited = null;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  ready.catch(() => { /* settled by the boot await below; this only stops an unhandled-rejection warning */ });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.notify === 'ready') { readyResolve(); continue; }
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error && msg.error.message ? msg.error.message : 'broker error'));
    }
  });
  // Fail FAST on a dead child rather than sitting out the boot timeout. This mirrors the §11 contract
  // in broker-client.ts, and it is also what makes the in-archive control produce a verdict in
  // milliseconds instead of three minutes.
  child.on('error', (err) => {
    exited = `spawn error: ${err.message}`;
    readyReject(new Error(exited));
  });
  child.on('exit', (code, signal) => {
    exited = `broker exited early (code=${code} signal=${signal})`;
    readyReject(new Error(exited));
  });

  const withTimeout = (pr, ms, what) => {
    let timer;
    // NOT unref'd. An unref'd timer is invisible to the event loop, so once the child is gone there is
    // nothing left to keep the process alive and it exits 0 having decided nothing.
    const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); });
    return Promise.race([pr, guard]).finally(() => clearTimeout(timer));
  };

  try {
    await withTimeout(ready, BOOT_TIMEOUT_MS, 'broker boot');
  } catch (err) {
    return fail('ready', `${err.message}${exited ? ` — ${exited}` : ''}; stderr: ${stderr.slice(-1200)}`);
  }
  pass('ready', 'broker announced ready');

  let nextId = 1;
  const rpc = (method, params) => {
    const id = nextId++;
    const pr = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return withTimeout(pr, CALL_TIMEOUT_MS, `rpc ${method}`);
  };

  // --- round trip THROUGH the broker ---------------------------------------------------------
  try {
    const pong = await rpc('ping');
    if (pong !== 'pong') throw new Error(`ping returned ${JSON.stringify(pong)}`);
    pass('ping', 'pong');

    await rpc('persistSessionFetch', {
      sessionId: SESSION_ID,
      url: 'https://example.invalid/broker-probe',
      title: `broker probe ${SENTINEL}`,
      markdown: `# broker probe\n\nThe sentinel token is ${SENTINEL} and it is written through the broker.\n`,
      credentialSignal: { fields: [] },
    });
    const artifacts = await rpc('listArtifacts', { sessionId: SESSION_ID, limit: 10 });
    if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('listArtifacts returned nothing after a persist');
    pass('roundTrip', `persisted + read back ${artifacts.length} artifact(s)`);
  } catch (err) {
    return fail('roundTrip', `${err.message}; stderr: ${stderr.slice(-1200)}`);
  }

  // Stop the broker before inspecting its DB, so WAL content is settled and nothing is mid-write.
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((r) => {
      const t = setTimeout(r, 5_000);
      child.once('exit', () => { clearTimeout(t); r(); });
    });
  }

  if (skipDbInspect) return finish(0);

  // --- what the broker's own SQLite build did ------------------------------------------------
  // Read with the packaged engine, anchored the same way, against the DB the BROKER created. Every
  // assertion below is a fact about the broker process, not about this one.
  const req = createRequire(anchor);
  const dbPath = path.join(dataDir, 'wigolo.db');
  if (!fs.existsSync(dbPath)) return fail('fts5', `the broker created no database at ${dbPath}`);

  let db;
  try {
    const Database = req('better-sqlite3');
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    return fail('fts5', `cannot open the broker's database: ${err.message}`);
  }

  try {
    // FTS5: the row went in through an RPC call and comes back out through the full-text index the
    // broker's own SQLite build maintained. A broker with no FTS5 would have failed at CREATE.
    const hit = db.prepare('SELECT count(*) AS n FROM studio_artifacts_fts WHERE studio_artifacts_fts MATCH ?').get(SENTINEL);
    if (!hit || hit.n < 1) throw new Error(`FTS5 MATCH on the broker-written row returned ${hit ? hit.n : 'nothing'}`);
    pass('fts5', `MATCH '${SENTINEL}' -> ${hit.n} row(s) in studio_artifacts_fts`);
  } catch (err) {
    return fail('fts5', err);
  }

  try {
    // vec: `CREATE VIRTUAL TABLE … USING vec0` throws "no such module: vec0" when the extension did
    // not load, and the migration that creates it is gated on `requiresVec`. So the table existing is
    // proof the BROKER loaded sqlite-vec — the one fact this process cannot fake for it. Then load the
    // extension here too and actually query the table, because a table that cannot be read is not a
    // working vector store.
    const created = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_documents'").get();
    if (!created) throw new Error('the broker did not create vec_documents — its sqlite-vec extension failed to load');
    if (/vector search disabled/.test(stderr)) throw new Error(`the broker logged a vec load failure: ${stderr.slice(-600)}`);
    db.loadExtension(req('sqlite-vec').getLoadablePath());
    const knn = db
      .prepare('SELECT rowid FROM vec_documents WHERE embedding MATCH ? ORDER BY distance LIMIT 1')
      .all(Buffer.from(new Float32Array(384).fill(0.1).buffer));
    pass('vec', `broker created vec_documents; KNN executed, ${knn.length} row(s)`);
  } catch (err) {
    return fail('vec', err);
  } finally {
    try { db.close(); } catch { /* closing a probe DB is best-effort */ }
  }

  finish(0);
}

main().catch((err) => fail('probe', err));
