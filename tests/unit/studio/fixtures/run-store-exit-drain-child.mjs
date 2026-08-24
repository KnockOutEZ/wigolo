/**
 * A process that appends and then dies without ever giving the loop a turn.
 *
 * The broker child hard-exits on SIGTERM and on the parent closing its stdin pipe (no-orphan,
 * spec §11), so this is not a synthetic shape — it is how the store's own process ends. An in-process
 * test cannot make the claim: the assertion is about what survives `process.exit`.
 *
 * argv: <dataDir> <idFile> <mode>
 *   immediate — exit in the same tick as the appends: nothing has landed, everything is queued.
 *   raced     — block the loop for 100ms first, so the drain runs against a queue the kernel has been
 *               chewing on rather than one it has not started.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const [dataDir, idFile, mode] = process.argv.slice(2);
const dist = join(import.meta.dirname, '..', '..', '..', '..', 'dist');
const { applyMigrations } = await import(pathToFileURL(join(dist, 'cache/migrations/runner.js')).href);
const { createRun, appendEvent } = await import(pathToFileURL(join(dist, 'studio/run-store.js')).href);

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
applyMigrations(db, { vecLoaded: false });

const run = createRun(db, { task: 'exit drain' }, { dataDir });
for (let i = 0; i < 5; i++) {
  appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: i } }, { dataDir });
}
// Not stdout: a piped write is itself asynchronous and would be lost by the exit under test.
writeFileSync(idFile, run.id);

if (mode === 'raced') {
  const until = Date.now() + 100;
  while (Date.now() < until) { /* hold the loop shut, let the threadpool finish */ }
}
process.exit(0);
