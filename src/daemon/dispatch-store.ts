/**
 * How the three dispatch mechanisms — the footer, the baton gate and the delivery queue — reach the
 * run log, and the one place that decides it (#331).
 *
 * THE DEFECT THIS EXISTS FOR. Each mechanism used to resolve the log through `getDatabase()` and
 * nothing else, and `setStudioHost` constructed all three with no options, so there was no seam
 * through which a host that reaches its store some other way could supply one. Post-PX0 the desktop
 * app IS the studio host, and its main process deliberately never loads a native store — a
 * plain-Node child owns the cache DB and the app talks to it over an async port. So every mechanism
 * was inert in the shipped product: not broken, INERT. Results rendered `— no run —`, the baton
 * allowed on absence by design, and a queued message never rode a result. Nothing errored, which is
 * why unit-level coverage stayed green through all of it.
 *
 * THE SEAM IS A PORT, NOT A HANDLE. The whole point is a caller with no native handle, so what a
 * host supplies is a `RunsStore` — the port the REST surface has spoken since SD1, which the app
 * already binds to its broker. A host with a handle keeps the handle: `openDb` is still honoured,
 * and is simply bound through `sqliteRunsStore` on the way in.
 *
 * ONE PATH, NOT TWO. Both inputs collapse to a port before any mechanism sees them, so the native
 * host and the port-only host run the SAME code below this line. That is what makes "the footer is
 * byte-identical over a handle and over a port" a claim a test can hold, rather than two
 * implementations that agree until one of them is edited.
 */
import type Database from 'better-sqlite3';
import type { RunsStore } from './rest/runs-store.js';

export interface DispatchStoreOptions {
  /**
   * The run store as a PORT — what a host that cannot hold a native handle supplies. Wins over
   * `openDb` when both are given: a host that has bound its own store has said which one is real.
   */
  openStore?: () => Promise<RunsStore | undefined>;
  /**
   * The run log as a native handle. Resolved per call and allowed to fail: a process that cannot
   * open the store simply has no run to project, and failing a tool call over that would be worse
   * than the surface each mechanism had before it existed.
   */
  openDb?: () => Promise<Database.Database | undefined>;
}

/**
 * One binding per handle. The handle is the identity — `getDatabase()` returns the same one for the
 * life of the process — so the alternative is minting a fresh closure set on every tool call for no
 * gain. Weak so a test's throwaway database is not held alive by this module.
 */
const bindings = new WeakMap<Database.Database, RunsStore>();

async function bind(db: Database.Database): Promise<RunsStore> {
  const held = bindings.get(db);
  if (held) return held;
  // Imported here rather than at the top: the binding lives under `rest/`, which imports the queue
  // that imports this module, and a static edge would close that cycle. It also keeps the REST
  // surface out of the boot path, which is the rule the lazy router already follows.
  const { sqliteRunsStore } = await import('./rest/runs-store.js');
  const store = sqliteRunsStore(db);
  bindings.set(db, store);
  return store;
}

async function defaultDb(): Promise<Database.Database | undefined> {
  try {
    const { getDatabase } = await import('../cache/db.js');
    return getDatabase();
  } catch {
    return undefined;
  }
}

/**
 * The store resolver a mechanism calls once per tool call. Never throws — every caller treats
 * `undefined` as "no run to project", which is the degradation each of them already documents.
 */
export function resolveDispatchStore(options: DispatchStoreOptions = {}): () => Promise<RunsStore | undefined> {
  if (options.openStore) return options.openStore;
  const openDb = options.openDb ?? defaultDb;
  return async () => {
    const db = await openDb();
    return db ? bind(db) : undefined;
  };
}
