import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { BROKER_TABLES } from '../../../src/companion-contract/broker.js';

/**
 * SD6 §3 (A-17-3) — the site-profile store's schema half.
 *
 * The column set is the contract, not an implementation detail: §3 names it verbatim and the domain
 * module that lands app-side (`wigolo-studio-run#388`) writes CLOSED row literals of exactly these
 * columns over a broker that reads the column list off this file and throws `BrokerOpError` — not a
 * refusal — on a name it does not find. So a dropped, renamed or retyped column here is a throw on
 * the wire rather than a local edit, and this suite pins every one of them.
 *
 * The other half — that a grant is the only key to those cells, in both modes — is pinned over real
 * broker ops against a real migrated database in `tests/integration/studio-site-profiles-broker.test.ts`.
 */

const NAME = '024-studio-site-profiles';

const TABLES = ['studio_site_profiles', 'studio_site_grants', 'studio_site_memories'] as const;

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function columnsOf(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info(${table})`) as ColumnInfo[];
}

function shapeOf(db: Database.Database, table: string): Array<Omit<ColumnInfo, never>> {
  return columnsOf(db, table).map((c) => ({
    name: c.name,
    type: c.type,
    notnull: c.notnull,
    dflt_value: c.dflt_value,
    pk: c.pk,
  }));
}

function freshDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

/**
 * Apply every migration EXCEPT the one under test, recording each as applied — the shape of a user
 * database that has been running since before this migration existed. A fresh DB proves the CREATE
 * works, not that it forward-applies onto history.
 */
function seedThroughPrior(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const m of MIGRATIONS) {
    if (m.name === NAME) break;
    if (m.requiresVec) continue;
    db.transaction(() => {
      db.exec(m.sql);
      m.postStep?.(db);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, 1);
    })();
  }
}

/** One profile as §3 shapes it — every column, so a dropped one shows up as a bind error. */
const PROFILE = Object.freeze({
  domain: 'expensify.com',
  created_at: 1_700_000_000_000,
  run_count: 4,
  visibility: 'text_only',
  view_rules: JSON.stringify({ hide: ['.promo'] }),
  flags: JSON.stringify({ injection_reported: true }),
});

/** One persistent "remember for this site" grant, as the grant card writes one. */
const GRANT = Object.freeze({
  id: 'sg-1',
  domain: 'expensify.com',
  scope: 'read_page',
  granted_at: 1_700_000_001_000,
  writer: 'human',
});

/** One junction row: the profile REFERENCES a memory, it never embeds one (A-16-9). */
const LINK = Object.freeze({
  domain: 'expensify.com',
  memory_id: 'mem-7fq2',
  linked_at: 1_700_000_002_000,
});

function insert(db: Database.Database, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((c) => row[c] as never));
}

function planFor(db: Database.Database, sql: string, ...params: unknown[]): string {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>;
  return plan.map((r) => r.detail).join(' | ');
}

describe('024-studio-site-profiles migration', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-mig-024-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('claims a migration name that has never existed (D15 rename-nothing)', () => {
    const names = MIGRATIONS.map((m) => m.name);
    // Name-keyed, NOT number-ordered: duplicate numeric prefixes already exist on disk
    // (008-* and 010-* each appear twice), so a numeric check would pass on a real collision.
    expect(names.filter((n) => n === NAME)).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the .sql mirror byte-identical to the registered constant', () => {
    const entry = MIGRATIONS.find((m) => m.name === NAME);
    expect(entry).toBeDefined();
    const onDisk = readFileSync(new URL(`../../../src/cache/migrations/${NAME}.sql`, import.meta.url), 'utf8');
    // The registry is the executed copy and the .sql file is the reviewable one. Drift between them
    // means a reviewer reads a schema no machine ever applied.
    expect(onDisk.trim()).toBe(entry!.sql.trim());
  });

  it('creates studio_site_profiles with the §3 column set, verbatim and in order', () => {
    const db = freshDb();
    // Types, nullability, defaults and the primary key are all asserted, not just the names: the
    // app's row literals are CLOSED literals of exactly this set over a broker that throws on an
    // unknown column, so a retyped column is a wire break no other test would see.
    expect(shapeOf(db, 'studio_site_profiles')).toEqual([
      { name: 'domain', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'run_count', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
      { name: 'visibility', type: 'TEXT', notnull: 1, dflt_value: "'full'", pk: 0 },
      { name: 'view_rules', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'flags', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    ]);
    db.close();
  });

  it('creates studio_site_grants with the §3 column set, verbatim and in order', () => {
    const db = freshDb();
    expect(shapeOf(db, 'studio_site_grants')).toEqual([
      { name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'domain', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'scope', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'granted_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'writer', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    ]);
    db.close();
  });

  it('creates studio_site_memories as a junction keyed on the pair itself', () => {
    const db = freshDb();
    // pk 1 and 2, not 1 and 0: the composite key IS the fact that a domain references a memory, so
    // a surrogate id would let a retried write claim the same link twice.
    expect(shapeOf(db, 'studio_site_memories')).toEqual([
      { name: 'domain', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
      { name: 'memory_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 2 },
      { name: 'linked_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    ]);
    db.close();
  });

  it('forward-applies onto a database that predates it, without re-running its history', () => {
    const db = new Database(join(dir, 'cache.db'));
    db.pragma('foreign_keys = ON');
    seedThroughPrior(db);
    for (const table of TABLES) expect(columnsOf(db, table), table).toHaveLength(0);

    _resetMigrationGuard();
    applyMigrations(db, { vecLoaded: false });

    for (const table of TABLES) expect(columnsOf(db, table), table).not.toHaveLength(0);
    expect(
      db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(NAME) as Array<{ name: string }>,
    ).toHaveLength(1);
    db.close();
  });

  it('defaults a new profile to full visibility and a zero run count', () => {
    const db = freshDb();
    // A fold that started at NULL would make the first increment a no-op, and a NULL visibility
    // would make "what can the agent see here" unanswerable on the row that has never been edited.
    insert(db, 'studio_site_profiles', { domain: PROFILE.domain, created_at: PROFILE.created_at });
    expect(db.prepare('SELECT run_count, visibility FROM studio_site_profiles WHERE domain = ?').get(PROFILE.domain))
      .toEqual({ run_count: 0, visibility: 'full' });
    db.close();
  });

  it('accepts a visibility mode this core has never heard of, because there is no CHECK', () => {
    const db = freshDb();
    // D15 makes a released migration's text history: a CHECK freezing today's three modes into the
    // file would make the fourth a table rebuild on every existing database. This asserts the
    // absence is real — all three land, and so does a mode from the future, which is what lets an
    // app one migration ahead of the core it paired into write at all (D8).
    const modes = ['full', 'text_only', 'hidden', 'mode-from-the-future'];
    for (const [i, visibility] of modes.entries()) {
      insert(db, 'studio_site_profiles', { ...PROFILE, domain: `d${i}.example`, visibility });
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_site_profiles').get()).toEqual({ n: modes.length });
    db.close();
  });

  it('accepts a grant writer this core has never heard of, for the same D8/D15 reason', () => {
    const db = freshDb();
    // The human-only posture is a law-12 control and it is NOT here: a table has no actor to test.
    // It lives in the domain module, above the wire, and this row records who claimed it.
    for (const [i, writer] of ['human', 'writer-from-the-future'].entries()) {
      insert(db, 'studio_site_grants', { ...GRANT, id: `sg-${i}`, writer });
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_site_grants').get()).toEqual({ n: 2 });
    db.close();
  });

  it('rejects a row missing any NOT NULL column, on each of the three tables', () => {
    const db = freshDb();
    const cases = [
      ['studio_site_profiles', PROFILE, ['created_at', 'run_count', 'visibility']],
      ['studio_site_grants', GRANT, ['domain', 'scope', 'granted_at', 'writer']],
      ['studio_site_memories', LINK, ['domain', 'memory_id', 'linked_at']],
    ] as const;
    for (const [table, row, columns] of cases) {
      for (const column of columns) {
        expect(() => insert(db, table, { ...row, [column]: null }), `${table}.${column} must be NOT NULL`).toThrow(
          /NOT NULL/,
        );
      }
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    db.close();
  });

  it('keeps one row per domain, so a profile has exactly one home', () => {
    const db = freshDb();
    insert(db, 'studio_site_profiles', PROFILE);
    expect(() => insert(db, 'studio_site_profiles', { ...PROFILE, run_count: 99 })).toThrow(/UNIQUE|PRIMARY KEY/i);
    db.close();
  });

  it('makes the same domain→memory link idempotent and a different memory a second link', () => {
    const db = freshDb();
    insert(db, 'studio_site_memories', LINK);
    // Re-linking is the SAME fact arriving twice (a retried write), not a second reference.
    expect(() => insert(db, 'studio_site_memories', { ...LINK, linked_at: LINK.linked_at + 1 })).toThrow(
      /UNIQUE|PRIMARY KEY/i,
    );
    // The same memory on another domain, and another memory on this one, are both genuinely new.
    insert(db, 'studio_site_memories', { ...LINK, domain: 'mail.google.com' });
    insert(db, 'studio_site_memories', { ...LINK, memory_id: 'mem-other' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_site_memories').get()).toEqual({ n: 3 });
    db.close();
  });

  it('serves the per-domain grant listing from its index with no sort step', () => {
    const db = freshDb();
    // The index ends in granted_at, so "what has this domain been granted, in order" is the same
    // traversal as the seek. A TEMP B-TREE here means every profile card open pays a full sort.
    const detail = planFor(
      db,
      'SELECT * FROM studio_site_grants WHERE domain = ? ORDER BY granted_at',
      GRANT.domain,
    );
    expect(detail).toContain('idx_studio_site_grants_domain');
    expect(detail).not.toContain('SCAN studio_site_grants');
    expect(detail).not.toContain('TEMP B-TREE');
    db.close();
  });

  it('serves the reverse junction walk — which sites reference this memory — from its own index', () => {
    const db = freshDb();
    // The forward direction is the composite PK's own index; this is the direction deleting a
    // memory has to ask before it can say what it is about to change.
    const detail = planFor(db, 'SELECT domain FROM studio_site_memories WHERE memory_id = ?', LINK.memory_id);
    expect(detail).toContain('idx_studio_site_memories_memory');
    expect(detail).not.toContain('SCAN studio_site_memories');

    insert(db, 'studio_site_memories', LINK);
    insert(db, 'studio_site_memories', { ...LINK, domain: 'mail.google.com' });
    insert(db, 'studio_site_memories', { ...LINK, memory_id: 'mem-other' });
    expect(
      (db.prepare('SELECT domain FROM studio_site_memories WHERE memory_id = ? ORDER BY domain').all(
        LINK.memory_id,
      ) as Array<{ domain: string }>).map((r) => r.domain),
    ).toEqual(['expensify.com', 'mail.google.com']);
    db.close();
  });

  it('has no column anywhere that could carry a credential', () => {
    const db = freshDb();
    // Structural, not conventional: a profile is portable (§3 export/import) and a clearance value
    // is UA/route-bound, so a column able to hold one would make an exported profile a portable auth
    // artifact. Asserted over the migrated database rather than over the .sql text, because the
    // database is what a writer can actually bind to.
    for (const table of TABLES) {
      for (const column of columnsOf(db, table)) {
        expect(column.name, `${table}.${column.name}`).not.toMatch(
          /cookie|password|passwd|token|secret|credential|clearance|session_?id|bearer/i,
        );
      }
    }
    db.close();
  });

  it('gives studio_site_profiles no integer key, so the wire can offer it no cursor', () => {
    const db = freshDb();
    // The broker reads its since/before column off the storage — `seq`, else an INTEGER `id` — and a
    // TEXT key would make `>` a string comparison over an order nothing wrote in. §3 pins that the
    // profile listing pages by a narrowing `where` plus a client-side slice instead, so the ABSENCE
    // of an integer key is the design. The refusal it produces is pinned over real ops in the
    // integration suite.
    for (const table of ['studio_site_profiles', 'studio_site_memories'] as const) {
      expect(columnsOf(db, table).map((c) => c.name)).not.toContain('seq');
      expect(columnsOf(db, table).map((c) => c.name)).not.toContain('id');
    }
    const grantId = columnsOf(db, 'studio_site_grants').find((c) => c.name === 'id');
    expect(grantId?.type).toBe('TEXT');
    expect(grantId?.type).not.toContain('INT');
    db.close();
  });

  it('puts all three tables on the wire, so nothing here is stranded off it', () => {
    // Named rather than counted: a table dropping out of the contract has to be noticed here, not
    // silently stop being reachable by an app that still has a screen for it.
    for (const table of TABLES) expect(BROKER_TABLES as readonly string[]).toContain(table);
  });
});
