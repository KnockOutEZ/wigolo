/**
 * Broker wire — grant-scoped, TABLE-scoped access to the shared cache.
 *
 * The broker is DUMB by design. Its ops name a table and carry typed cells; they never name a domain
 * operation. That is the point: the app and the external core can be at different schema heads, and a
 * table-scoped op on a table that must exist per the app's declared minimum is schema-tolerant, where a
 * domain method (persist-a-mark, create-a-run, synthesise-a-session) bakes today's column set and today's
 * business rules into the wire and breaks on the first migration either side ships alone. So the shapes
 * below are derived from the STORAGE, not from the current handler surface.
 *
 * A drift test asserts that no current handler NAME appears in this file: the moment one does, the wire
 * has started describing behaviour instead of storage, which is the failure this design exists to avoid.
 *
 * Ownership rule that outranks everything here: only the EXTERNAL core runs migrations on the shared
 * cache. The app never migrates a database it paired into. The grant carries the head it was issued
 * against so a skew that appears mid-pairing is revocable rather than silently tolerated.
 *
 * Pure shapes and pure guards only — no I/O, no imports outside this directory.
 */

/**
 * The shared tables a grant can name, CLOSED.
 *
 * This is the REAL table set, verified against the migrations. It is not the app's convenience list: the
 * run projections read `studio_runs` + `studio_run_events`, and omitting either strands paired-mode runs.
 *
 * `studio_memories` (SD5 §6.1) is here for the same reason and needs BOTH modes, unlike the tables the
 * companion only projects: the memories surface is where a person adds, edits and archives a memory, so
 * a read-only entry would ship the screen with its two write affordances dead. Its semantics — revise
 * writes a new row and archives the old, expired rows drop out of active listings — are the companion's,
 * expressed as ordinary insert/update ops on this table. The broker stays dumb; it does not learn what a
 * memory is.
 *
 * `studio_annotations` (SD4 §4.1) is here on the same terms and also needs BOTH modes. It is where a
 * mark, note, ink stroke, label, fence, redaction, scope or assertion durably lives, and both authors
 * write it: a person marking a page, and an agent creating a restrictive row. A read-only entry would
 * ship the annotation layer as a display of rows nothing could add to. Its semantics — a revise writes
 * a new row carrying `supersedes` and archives the old, policy-kind rows may be archived only by a
 * human — are the companion's, expressed here as ordinary insert/update ops on one table. The broker
 * stays dumb; it does not learn what an annotation is, and it is not where the human-only archival
 * asymmetry is enforced (a table-scoped wire cannot see an actor).
 *
 * The three `studio_site_*` tables (SD6 §3, A-17-3) are here on the same terms and all three need
 * BOTH modes. `studio_site_profiles` is the per-domain row a person edits from the profile card
 * (visibility, view rules, flags) and whose `run_count` fold the app maintains; `studio_site_grants`
 * is the persistent "remember for this site" layer a person writes through the grant card; and
 * `studio_site_memories` is the domain→memory junction the app is the only writer of. A read-only
 * entry on any of them would ship a profile surface that nothing can populate. As with the two
 * above, the semantics — the closed visibility set, the human-only grant writer, the serialised
 * read-modify-write of `run_count` — belong to the companion and are expressed here as ordinary
 * insert/update/delete ops. The broker does not learn what a site profile is.
 */
export const BROKER_TABLES = Object.freeze([
  'studio_annotations',
  'studio_artifacts',
  'studio_audit',
  'studio_flow_steps',
  'studio_memories',
  'studio_run_events',
  'studio_runs',
  'studio_sessions',
  'studio_site_grants',
  'studio_site_memories',
  'studio_site_profiles',
] as const);

export type BrokerTable = (typeof BROKER_TABLES)[number];

/**
 * The HTTP route broker ops ride, appended to the base URL of whichever core owns the database — the
 * paired external daemon, or the app's own embedded core. The ADDRESS belongs to the wire for the same
 * reason the op set does: two sides that disagree about it trade 404s, and a 404 is indistinguishable at
 * the client from "no core there". One route, two base URLs, one client code path.
 */
export const BROKER_ROUTE = '/companion/broker';

/**
 * Ceiling on the rows one read may name, enforced BEFORE the storage is touched (`row_limit_exceeded`).
 *
 * A broker read answers as one JSON body that the caller parses in a single synchronous step, so an
 * unbounded `limit` is an unbounded parse on whichever thread asked. The bound is stated in ROWS because
 * that is the only quantity the op carries — the broker does not own the column set, so it cannot price a
 * row before reading it. Callers that want more paginate with `since`/`before`, which is what the cursor is
 * for. Reversal condition: if a caller ever needs a whole table in one frame, that is a streaming op with
 * its own shape, not a bigger number here.
 */
export const MAX_BROKER_ROWS = 1_000;

/** What a stored cell can be — the storage engine's value domain, nothing richer. */
export type BrokerCell = string | number | boolean | null;

/** One stored row, addressed by column name. Deliberately open: the broker does not own the column set. */
export type BrokerRow = Record<string, BrokerCell>;

/** `read` grants reads only; `readwrite` grants both. There is no write-only grant. */
export type BrokerMode = 'read' | 'readwrite';

/** The access a grant is being checked for. */
export type BrokerAccess = 'read' | 'write';

/**
 * A live grant. The token is the bearer of everything: an op with no token, an unknown token or a revoked
 * one is refused before any table is touched. `schemaHead` is the head the grant was issued against, so a
 * later skew is a revocation reason rather than a silent tolerance.
 */
export interface BrokerGrant {
  token: string;
  issuedAt: number;
  /** Absolute expiry. Absent means the grant lives until it is revoked. */
  expiresAt?: number;
  mode: BrokerMode;
  tables: readonly BrokerTable[];
  schemaHead: number;
}

/** A table-scoped read. `where` is an equality filter on stored cells — no expression language on the wire. */
export interface BrokerReadOp {
  grant: string;
  kind: 'read';
  table: BrokerTable;
  where?: BrokerRow;
  limit: number;
  /** Cursor over the table's monotonic ordering column, when it has one (`seq`, `id`). */
  since?: number;
  before?: number;
}

export const BROKER_WRITE_KINDS = Object.freeze(['delete', 'insert', 'update'] as const);

export type BrokerWriteKind = (typeof BROKER_WRITE_KINDS)[number];

/** A table-scoped write. `row` carries the cells to insert or set; `where` selects for update/delete. */
export interface BrokerWriteOp {
  grant: string;
  kind: BrokerWriteKind;
  table: BrokerTable;
  row?: BrokerRow;
  where?: BrokerRow;
}

export type BrokerOp = BrokerReadOp | BrokerWriteOp;

/** Why a grant was withdrawn. Unpairing is the ordinary one; the rest are the machine's own. */
export const BROKER_REVOCATION_REASONS = Object.freeze([
  'expired',
  'schema_skew',
  'superseded',
  'unpaired',
] as const);

export type BrokerRevocationReason = (typeof BROKER_REVOCATION_REASONS)[number];

export interface BrokerRevocation {
  token: string;
  revokedAt: number;
  reason: BrokerRevocationReason;
}

/**
 * Every reason an op can be refused, CLOSED. All of them are decided BEFORE the storage is touched, so a
 * refusal never leaves a partial write behind — an in-flight op completes or aborts atomically.
 */
export const BROKER_REFUSAL_REASONS = Object.freeze([
  'grant_expired',
  'grant_revoked',
  'no_grant',
  'row_limit_exceeded',
  'table_not_granted',
  'unknown_table',
  'write_not_granted',
] as const);

export type BrokerRefusalReason = (typeof BROKER_REFUSAL_REASONS)[number];

export interface BrokerRefusal {
  ok: false;
  reason: BrokerRefusalReason;
  /** The table the op named, when it named one — the single most useful thing to report back. */
  table?: BrokerTable;
}

export type BrokerResult<TData> = { ok: true; rows: readonly TData[] } | BrokerRefusal;

const REFUSAL_REASON_SET: ReadonlySet<string> = new Set(BROKER_REFUSAL_REASONS);

/** True for a well-formed refusal arm — the reason must be IN the closed enum. */
export function isBrokerRefusal(value: unknown): value is BrokerRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { ok?: unknown; reason?: unknown };
  return v.ok === false && typeof v.reason === 'string' && REFUSAL_REASON_SET.has(v.reason);
}

/**
 * True when `grant` authorises `access` on `table`. Pure and clock-injected: the caller passes `now`
 * because the two sides of a pairing do not share a clock, and a grant check that silently read the local
 * one would make expiry mean something different on each side of the wire.
 *
 * Expiry is exclusive of the boundary — a grant expiring at T is dead AT T, not one tick later.
 */
export function grantCovers(
  grant: BrokerGrant,
  table: BrokerTable,
  access: BrokerAccess,
  now?: number,
): boolean {
  if (grant.expiresAt !== undefined && now !== undefined && now >= grant.expiresAt) return false;
  if (access === 'write' && grant.mode !== 'readwrite') return false;
  return grant.tables.includes(table);
}
