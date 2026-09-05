/**
 * The companion broker — grant-scoped, TABLE-scoped access to the shared cache, and nothing else.
 *
 * It is DUMB on purpose (spec D8). It knows six table names, four op kinds and a grant; it does not know
 * what a run is, what a mark is, or what an artifact means. Every projection, DTO and domain rule that
 * used to live here now lives in the companion, which re-implements them ON TOP of these ops. That is the
 * whole trade: the two sides can be at different schema heads and still speak, because a table-scoped op
 * against a table that must exist per the app's declared minimum survives a migration either side ships
 * alone, where a domain method bakes today's column set into the wire and breaks on the first one.
 *
 * Three properties this module owes its callers, each pinned by a test:
 *
 *  1. **Nothing without a live grant.** No grant, an unknown token, a revoked one or an expired one is
 *     refused before a statement is prepared. Read grants cannot write.
 *  2. **Refusals never leave residue.** Every refusal is decided BEFORE the storage is touched, and every
 *     write runs inside one transaction, so an op either completes or leaves the table byte-identical.
 *  3. **Identifiers are never interpolated from the wire.** Table names come from the CLOSED contract set;
 *     column names are checked against the table's real columns read from the database itself. Values are
 *     always bound. A wire that names a column the table does not have is a malformed op, not a refusal —
 *     the refusal enum is closed and shared, and a protocol error is not an access decision.
 */
import type Database from 'better-sqlite3';
import {
  BROKER_TABLES,
  BROKER_WRITE_KINDS,
  MAX_BROKER_ROWS,
  grantCovers,
} from '../companion-contract/broker.js';
import type {
  BrokerAccess,
  BrokerCell,
  BrokerGrant,
  BrokerMode,
  BrokerOp,
  BrokerRefusal,
  BrokerResult,
  BrokerRevocation,
  BrokerRevocationReason,
  BrokerRow,
  BrokerTable,
} from '../companion-contract/broker.js';
import { MIGRATIONS } from '../cache/migrations/runner.js';
import { createLogger } from '../logger.js';

const log = createLogger('companion-broker');

const TABLE_SET: ReadonlySet<string> = new Set(BROKER_TABLES);

/**
 * How many revoked tokens the ledger remembers.
 *
 * The ledger exists so a token whose pairing ended answers `grant_revoked` — "your pairing ended,
 * re-pair" — instead of the bare `no_grant` it would get once forgotten. That is a courtesy with a
 * shelf life, and the map holding it is memory an unauthenticated loopback route lets a caller append
 * to: every `POST /companion/pair` supersedes the live grants, and each supersession used to add a row
 * nothing ever removed. Capping it trades the diagnosis for a bounded daemon, and only for tokens
 * revoked more than this many revocations ago — long past when their holder had a reason to retry.
 */
export const MAX_BROKER_REVOCATIONS = 1024;

/** True for a name in the contract's CLOSED table set — the only source of a table identifier. */
export function isBrokerTable(name: unknown): name is BrokerTable {
  return typeof name === 'string' && TABLE_SET.has(name);
}

const KIND_SET: ReadonlySet<string> = new Set<string>(['read', ...BROKER_WRITE_KINDS]);

/**
 * True for a kind in the contract's CLOSED op set.
 *
 * Derived from the contract rather than spelled out here, so a kind added there is dispatchable here in
 * the same commit and cannot be silently accepted by a guard that lists yesterday's four.
 */
export function isBrokerKind(kind: unknown): kind is BrokerOp['kind'] {
  return typeof kind === 'string' && KIND_SET.has(kind);
}

/**
 * A malformed op — a protocol error, distinct from a typed refusal.
 *
 * The refusal enum is closed and mirrored on the app side, so a wire that names a column the table does
 * not have cannot be reported through it without either inventing a reason both sides must learn, or
 * flattening a protocol bug into an access decision the operator would then go looking for a grant to fix.
 * It throws instead, and the route answers 400.
 */
export class BrokerOpError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'BrokerOpError';
  }
}

/**
 * The schema head this database is actually at: how many of the migrations this build knows have been
 * applied to THIS file.
 *
 * A count, not the highest numeric filename prefix, for two reasons. Prefixes collide — two different
 * `008-` migrations exist — so a maximum over them is not a position in the sequence. And a count
 * under-reports honestly when a migration was skipped (a vec-dependent one on a build without the
 * extension), where a maximum would claim a head the file has not reached and let a pairing through that
 * the app's minimum should have refused.
 *
 * Reversal condition: if migrations ever stop being applied in list order, a count stops being a
 * position and this becomes the index of the last applied entry instead.
 */
export function schemaHead(db: Database.Database): number {
  let applied: Set<string>;
  try {
    const rows = db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>;
    applied = new Set(rows.map((r) => r.name));
  } catch {
    // No migration ledger at all — an empty or foreign file. Head zero refuses every app minimum.
    return 0;
  }
  return MIGRATIONS.filter((m) => applied.has(m.name)).length;
}

/**
 * Columns the table really has, read from the database rather than from any list in this repo.
 *
 * Reading them from the file is what makes the broker schema-tolerant: a column an older core has never
 * heard of is still a real column of the table it is looking at, so an app one migration ahead can write
 * it, which is the entire point of a table-scoped wire.
 */
function columnsOf(db: Database.Database, table: BrokerTable): ReadonlyMap<string, string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
  if (rows.length === 0) {
    throw new BrokerOpError(`table ${table} does not exist in this database`);
  }
  return new Map(rows.map((r) => [r.name, (r.type ?? '').toUpperCase()]));
}

function assertColumns(db: Database.Database, table: BrokerTable, row: BrokerRow | undefined): void {
  if (!row) return;
  const known = columnsOf(db, table);
  for (const column of Object.keys(row)) {
    if (!known.has(column)) {
      throw new BrokerOpError(`table ${table} has no column ${column}`);
    }
  }
}

/** Stored cells only. A nested object or array on the wire is a protocol error, not a row. */
function assertCells(row: BrokerRow | undefined, where: string): void {
  if (!row) return;
  for (const [column, value] of Object.entries(row)) {
    const t = typeof value;
    if (value === null || t === 'string' || t === 'number' || t === 'boolean') continue;
    throw new BrokerOpError(`${where}.${column} is not a stored cell`);
  }
}

/** better-sqlite3 binds booleans as 0/1 only when told to; normalise here so one path binds every cell. */
function bind(value: BrokerCell): string | number | null {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function equalityClause(where: BrokerRow | undefined, params: Array<string | number | null>): string[] {
  if (!where) return [];
  const clauses: string[] = [];
  for (const [column, value] of Object.entries(where)) {
    if (value === null) {
      clauses.push(`"${column}" IS NULL`);
      continue;
    }
    clauses.push(`"${column}" = ?`);
    params.push(bind(value));
  }
  return clauses;
}

/**
 * The cursor column for a table, or undefined when it has none.
 *
 * `since`/`before` are the wire's only ordering, and the column they range over is a property of the
 * STORAGE, so it is read off the table rather than declared: `seq` where the table has one, else an
 * INTEGER `id`. The type check is the load-bearing half — three of the shared tables key on an opaque
 * TEXT id, where `>` is a string comparison and a caller paging by it would walk an order nothing wrote
 * in. A table with no integer ordering takes no cursor at all, and naming one against it is a protocol
 * error rather than a silently ignored bound, because a silently ignored bound re-reads page one forever.
 */
function cursorColumn(db: Database.Database, table: BrokerTable): string | undefined {
  const known = columnsOf(db, table);
  for (const candidate of ['seq', 'id']) {
    const type = known.get(candidate);
    if (type !== undefined && type.includes('INT')) return candidate;
  }
  return undefined;
}

export interface GrantStoreOptions {
  /** Injected clock — the two sides of a pairing do not share one, so this module never reads it globally. */
  now?: () => number;
  /** Lifetime of an issued grant in ms. Omitted (or 0) means the grant lives until it is revoked. */
  ttlMs?: number;
  /** Token minting, injected so a test can pin a token without reaching into crypto. */
  mintToken?: () => string;
  /** Size of the revocation ledger. Defaults to {@link MAX_BROKER_REVOCATIONS}; 0 or less is that default. */
  maxRevocations?: number;
}

export interface IssueGrantInput {
  mode: BrokerMode;
  tables: readonly BrokerTable[];
  schemaHead: number;
}

/**
 * The daemon's live grants.
 *
 * In memory, deliberately: a grant is the lifetime of one pairing with one running companion, and a grant
 * that outlived the daemon would be a credential on disk that nothing revokes when the app goes away.
 * Restarting the daemon un-pairs, and the companion re-pairs — which is the same shape as the handle file
 * it already re-reads.
 */
export class BrokerGrantStore {
  private readonly grants = new Map<string, BrokerGrant>();
  private readonly revocations = new Map<string, BrokerRevocation>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly mintToken: () => string;
  private readonly maxRevocations: number;

  constructor(options: GrantStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? 0;
    this.mintToken = options.mintToken ?? (() => globalThis.crypto.randomUUID());
    const cap = options.maxRevocations ?? MAX_BROKER_REVOCATIONS;
    this.maxRevocations = cap > 0 ? cap : MAX_BROKER_REVOCATIONS;
  }

  issue(input: IssueGrantInput): BrokerGrant {
    const issuedAt = this.now();
    const grant: BrokerGrant = {
      token: this.mintToken(),
      issuedAt,
      ...(this.ttlMs > 0 ? { expiresAt: issuedAt + this.ttlMs } : {}),
      mode: input.mode,
      tables: [...input.tables],
      schemaHead: input.schemaHead,
    };
    this.grants.set(grant.token, grant);
    log.debug('broker grant issued', { mode: grant.mode, tables: grant.tables.length, schemaHead: grant.schemaHead });
    return grant;
  }

  get(token: string): BrokerGrant | undefined {
    return this.grants.get(token);
  }

  /** Why a token is dead, or undefined if it was never issued here. */
  revocationOf(token: string): BrokerRevocation | undefined {
    return this.revocations.get(token);
  }

  /** Withdraw one grant. Idempotent: revoking a token that is already dead keeps the FIRST reason. */
  revoke(token: string, reason: BrokerRevocationReason): BrokerRevocation | null {
    const existing = this.revocations.get(token);
    if (existing) return existing;
    if (!this.grants.delete(token)) return null;
    const revocation: BrokerRevocation = { token, revokedAt: this.now(), reason };
    this.revocations.set(token, revocation);
    // Insertion order is revocation order, and the OLDEST revocation is the one to forget: a token dead
    // for a thousand pairings has had every chance to learn it. Eviction is deliberately not keyed on
    // access, because that would let a caller replaying one dead token keep it resident and push the
    // genuinely recent revocations out ahead of it.
    while (this.revocations.size > this.maxRevocations) {
      const oldest = this.revocations.keys().next();
      if (oldest.done === true) break;
      this.revocations.delete(oldest.value);
    }
    log.info('broker grant revoked', { reason });
    return revocation;
  }

  /** Withdraw every live grant — unpairing, or a daemon that is going away. */
  revokeAll(reason: BrokerRevocationReason): readonly BrokerRevocation[] {
    return [...this.grants.keys()]
      .map((token) => this.revoke(token, reason))
      .filter((r): r is BrokerRevocation => r !== null);
  }

  /** How many revocations the ledger holds — never more than the cap it was constructed with. */
  revocationCount(): number {
    return this.revocations.size;
  }

  /** Every live grant, expiry not considered — `authorize` is what decides liveness at op time. */
  list(): readonly BrokerGrant[] {
    return [...this.grants.values()];
  }

  /**
   * Decide a token's access to a table, with no storage involved.
   *
   * Ordering is load-bearing and pinned: token identity first (a revoked token is `grant_revoked` even
   * when it also names an ungranted table, because "your pairing ended" is the actionable answer and
   * "that table is not yours" would send the operator to re-scope a grant that no longer exists), then
   * expiry, then table scope, then write access.
   *
   * A token evicted from the bounded ledger falls through to `no_grant`: revocation deletes the grant,
   * so forgetting WHY a token is dead can only ever make it deader, never authorized again.
   */
  authorize(token: string | undefined, table: BrokerTable, access: BrokerAccess): BrokerGrant | BrokerRefusal {
    if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'no_grant', table };
    if (this.revocations.has(token)) return { ok: false, reason: 'grant_revoked', table };
    const grant = this.grants.get(token);
    if (!grant) return { ok: false, reason: 'no_grant', table };
    const now = this.now();
    if (grant.expiresAt !== undefined && now >= grant.expiresAt) {
      // An expired grant is dead the first time anyone notices, not merely refused each time: leaving it
      // in the live map would let it answer `list()` as live forever and re-decide expiry on every op.
      this.revoke(token, 'expired');
      return { ok: false, reason: 'grant_expired', table };
    }
    if (!grant.tables.includes(table)) return { ok: false, reason: 'table_not_granted', table };
    if (!grantCovers(grant, table, access, now)) {
      return { ok: false, reason: access === 'write' ? 'write_not_granted' : 'table_not_granted', table };
    }
    return grant;
  }
}

function isRefusal(value: BrokerGrant | BrokerRefusal): value is BrokerRefusal {
  return (value as BrokerRefusal).ok === false;
}

/**
 * Execute one op against the shared cache.
 *
 * Every decision that can refuse happens above the first prepared statement, and every write runs inside
 * one transaction, so a refused op and a failed op both leave the table exactly as they found it.
 * Reads answer rows; writes answer the rows they wrote — `insert` echoes what landed (so a caller learns
 * the rowid it did not supply), `update` and `delete` answer the affected count as one row, because the
 * count is the only thing SQLite will tell us without a second read the caller did not ask for.
 */
export function executeBrokerOp(
  db: Database.Database,
  grants: BrokerGrantStore,
  op: BrokerOp,
): BrokerResult<BrokerRow> {
  if (!isBrokerTable(op.table)) {
    return { ok: false, reason: 'unknown_table' };
  }
  // Decided here, not by the dispatch below. The dispatch is a chain of `if`s whose LAST arm is a
  // delete, so an unrecognised kind used to fall through into a destructive write — schema tolerance
  // degrading into a DIFFERENT mutation, which is exactly what spec §6 says it must never do. A kind
  // this build does not know is a protocol error and has to refuse; the detail names the closed set
  // rather than echoing what arrived, because the wire's own string is not ours to repeat.
  if (!isBrokerKind(op.kind)) {
    throw new BrokerOpError(`op.kind must be one of: read, ${BROKER_WRITE_KINDS.join(', ')}`);
  }
  const table = op.table;
  const access: BrokerAccess = op.kind === 'read' ? 'read' : 'write';

  const authorized = grants.authorize(op.grant, table, access);
  if (isRefusal(authorized)) return authorized;

  if (op.kind === 'read') {
    if (!Number.isInteger(op.limit) || op.limit <= 0) {
      throw new BrokerOpError('read.limit must be a positive integer');
    }
    if (op.limit > MAX_BROKER_ROWS) {
      return { ok: false, reason: 'row_limit_exceeded', table };
    }
    assertCells(op.where, 'where');
    assertColumns(db, table, op.where);

    const params: Array<string | number | null> = [];
    const clauses = equalityClause(op.where, params);
    // Ordered whenever the table CAN be ordered, not only when a cursor was named. A `LIMIT` without an
    // `ORDER BY` takes whichever rows the query plan reached first, so an unordered page would make
    // "the first ten events" mean something different after an index change — and a caller that paged by
    // the last row it saw would skip rows it never received.
    const cursor = cursorColumn(db, table);
    if ((op.since !== undefined || op.before !== undefined) && !cursor) {
      throw new BrokerOpError(`table ${table} has no cursor column`);
    }
    if (cursor) {
      if (op.since !== undefined) {
        clauses.push(`"${cursor}" > ?`);
        params.push(op.since);
      }
      if (op.before !== undefined) {
        clauses.push(`"${cursor}" < ?`);
        params.push(op.before);
      }
    }
    const order = cursor ? ` ORDER BY "${cursor}" ASC` : '';
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT * FROM ${table}${where}${order} LIMIT ?`)
      .all(...params, op.limit) as BrokerRow[];
    return { ok: true, rows };
  }

  assertCells(op.row, 'row');
  assertCells(op.where, 'where');
  assertColumns(db, table, op.row);
  assertColumns(db, table, op.where);

  if (op.kind === 'insert') {
    const columns = Object.keys(op.row ?? {});
    if (columns.length === 0) throw new BrokerOpError('insert.row must name at least one column');
    const placeholders = columns.map(() => '?').join(', ');
    const names = columns.map((c) => `"${c}"`).join(', ');
    const values = columns.map((c) => bind((op.row as BrokerRow)[c]!));
    const inserted = db.transaction(() =>
      db.prepare(`INSERT INTO ${table} (${names}) VALUES (${placeholders})`).run(...values),
    )();
    return { ok: true, rows: [{ changes: inserted.changes, lastInsertRowid: Number(inserted.lastInsertRowid) }] };
  }

  if (op.kind === 'update') {
    const columns = Object.keys(op.row ?? {});
    if (columns.length === 0) throw new BrokerOpError('update.row must name at least one column');
    const params: Array<string | number | null> = columns.map((c) => bind((op.row as BrokerRow)[c]!));
    const assignments = columns.map((c) => `"${c}" = ?`).join(', ');
    const clauses = equalityClause(op.where, params);
    // An unfiltered UPDATE rewrites the table. That is a whole-table mutation asked for by omission,
    // which is exactly the shape a bug takes, so it must be asked for explicitly.
    if (clauses.length === 0) throw new BrokerOpError('update requires a where filter');
    const changed = db.transaction(() =>
      db.prepare(`UPDATE ${table} SET ${assignments} WHERE ${clauses.join(' AND ')}`).run(...params),
    )();
    return { ok: true, rows: [{ changes: changed.changes }] };
  }

  // The last arm, reached only by `delete`: the guard at the top closed `op.kind` to the contract's
  // four, and the three arms above returned. A SECOND check here would be a second mechanism keyed on
  // the same predicate — it would keep this arm safe while the guard was reverted, which is exactly the
  // proof the guard's own test needs to be able to make.
  const params: Array<string | number | null> = [];
  const clauses = equalityClause(op.where, params);
  // Same reason as update, one step worse: an unfiltered DELETE empties the table.
  if (clauses.length === 0) throw new BrokerOpError('delete requires a where filter');
  const deleted = db.transaction(() =>
    db.prepare(`DELETE FROM ${table} WHERE ${clauses.join(' AND ')}`).run(...params),
  )();
  return { ok: true, rows: [{ changes: deleted.changes }] };
}
