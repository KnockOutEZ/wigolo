import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { BROKER_TABLES } from '../../../src/companion-contract/broker.js';

/**
 * SD9 §3 (3ac, A-420-4) — the voice-profile store's schema half.
 *
 * WRITING-tone profiles, not speech: §0a.4 defers the voice/audio frame (3ba) post-done and the
 * mini-spec's §0 rules 3ac distinct from it, so nothing here may imply audio machinery.
 *
 * The column set is the contract, not an implementation detail: the domain module that lands
 * app-side (SD9-B3) writes CLOSED row literals of exactly these columns over a broker that reads
 * the column list off this file and throws `BrokerOpError` — not a refusal — on a name it does not
 * find. A dropped, renamed or retyped column here is therefore a throw on the wire rather than a
 * local edit, and this suite pins every one of them.
 *
 * The other half — that a grant is the only key to those cells, in both modes — is pinned over real
 * broker ops against a real migrated database in `tests/integration/studio-sd9-tables-broker.test.ts`.
 */

const NAME = '025-studio-voice-profiles';

const TABLE = 'studio_voice_profiles';

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

function shapeOf(db: Database.Database, table: string): ColumnInfo[] {
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

/** One profile as 3ac shapes it — every column, so a dropped one shows up as a bind error. */
const PROFILE = Object.freeze({
  domain: 'linkedin.com',
  surface: 'post_composer',
  name: 'measured',
  exemplars: JSON.stringify(['Shipped the migration layer today.', 'Happy to walk anyone through it.']),
  learned_at: 1_700_000_000_000,
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

describe('025-studio-voice-profiles migration', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-mig-025-'));
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

  it('creates studio_voice_profiles with the 3ac column set, verbatim and in order', () => {
    const db = freshDb();
    // Types, nullability, defaults and the primary key are all asserted, not just the names: the
    // app's row literals are CLOSED literals of exactly this set over a broker that throws on an
    // unknown column, so a retyped column is a wire break no other test would see.
    expect(shapeOf(db, TABLE)).toEqual([
      { name: 'domain', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
      { name: 'surface', type: 'TEXT', notnull: 1, dflt_value: null, pk: 2 },
      { name: 'name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 3 },
      { name: 'exemplars', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'learned_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    ]);
    db.close();
  });

  it('forward-applies onto a database that predates it, without re-running its history', () => {
    const db = new Database(join(dir, 'cache.db'));
    db.pragma('foreign_keys = ON');
    seedThroughPrior(db);
    expect(columnsOf(db, TABLE)).toHaveLength(0);

    _resetMigrationGuard();
    applyMigrations(db, { vecLoaded: false });

    expect(columnsOf(db, TABLE)).not.toHaveLength(0);
    expect(
      db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(NAME) as Array<{ name: string }>,
    ).toHaveLength(1);
    db.close();
  });

  it('refuses a profile with no exemplars, because a tone learned from nothing is the generic one', () => {
    const db = freshDb();
    // 3ac's law: a profile is learned ONLY from text the user actually wrote on that site, never a
    // generic "professional tone". A NULL exemplars column is exactly that generic profile wearing
    // a site's name, so the absence is refused at the schema rather than left to a caller.
    expect(() => insert(db, TABLE, { ...PROFILE, exemplars: null })).toThrow(/NOT NULL/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 0 });
    db.close();
  });

  it('rejects a row missing any other NOT NULL column', () => {
    const db = freshDb();
    for (const column of ['domain', 'surface', 'name', 'learned_at']) {
      expect(() => insert(db, TABLE, { ...PROFILE, [column]: null }), `${TABLE}.${column}`).toThrow(/NOT NULL/);
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 0 });
    db.close();
  });

  it('accepts a composing surface this core has never heard of, because there is no CHECK', () => {
    const db = freshDb();
    // D15 makes a released migration's text history: a CHECK freezing today's surfaces into this
    // file would make the next one a table rebuild on every existing database. This asserts the
    // absence is real, which is what lets an app one migration ahead of the core it paired into
    // write at all (D8).
    for (const surface of ['post_composer', 'dm', 'email_reply', 'surface-from-the-future']) {
      insert(db, TABLE, { ...PROFILE, surface });
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 4 });
    db.close();
  });

  it('keys on the triple, so a surface can carry a second named tone but not the same one twice', () => {
    const db = freshDb();
    insert(db, TABLE, PROFILE);
    // Re-learning the SAME name on the same surface is that profile arriving again — a repeated
    // "+ learn from this field" — not a second profile beside it.
    expect(() => insert(db, TABLE, { ...PROFILE, exemplars: JSON.stringify(['other']) })).toThrow(
      /UNIQUE|PRIMARY KEY/i,
    );
    // `compose` resolves a profile by `voice_profile: text`, i.e. by NAME, so one surface must be
    // able to hold more than one named tone. A (domain, surface) key would make this unstorable,
    // and D15 makes that unfixable without a table rebuild on every existing database.
    insert(db, TABLE, { ...PROFILE, name: 'warm' });
    insert(db, TABLE, { ...PROFILE, surface: 'dm' });
    insert(db, TABLE, { ...PROFILE, domain: 'slack.com' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 4 });
    db.close();
  });

  it('serves the per-site profile listing from its index with no sort step', () => {
    const db = freshDb();
    // What the profile picker and the privacy dashboard both open with. The primary key's own index
    // seeks by domain but orders by surface, so recency ordering over it costs a sort on every open.
    const detail = planFor(db, `SELECT * FROM ${TABLE} WHERE domain = ? ORDER BY learned_at`, PROFILE.domain);
    expect(detail).toContain('idx_studio_voice_profiles_domain');
    expect(detail).not.toContain(`SCAN ${TABLE}`);
    expect(detail).not.toContain('TEMP B-TREE');
    db.close();
  });

  it('has no column that could carry a credential, and none that implies audio', () => {
    const db = freshDb();
    // Credentials: structural rather than conventional — exemplars are text the user typed into a
    // visible field, and a masked input's value never enters a snapshot in the first place (the
    // pinned same-origin stance), so no path reaches this table with a secret on it.
    //
    // Audio: §0a.4 defers speech (3ba) post-done and this table is the WRITING-tone store. A column
    // implying an audio artifact here would be that deferred frame arriving through the schema.
    for (const column of columnsOf(db, TABLE)) {
      expect(column.name, column.name).not.toMatch(
        /cookie|password|passwd|token|secret|credential|clearance|session_?id|bearer/i,
      );
      expect(column.name, column.name).not.toMatch(/audio|speech|voice_sample|tts|stt|utterance/i);
    }
    db.close();
  });

  it('gives the table no integer key, so the wire can offer it no cursor', () => {
    const db = freshDb();
    // The broker reads its since/before column off the storage — `seq`, else an INTEGER `id` — and a
    // TEXT key would make `>` a string comparison over an order nothing wrote in. A profile set is
    // bounded by the surfaces a person composes on, so it pages by a narrowing `where` exactly as
    // the site-profile listing does. The refusal that produces is pinned in the integration suite.
    const names = columnsOf(db, TABLE).map((c) => c.name);
    expect(names).not.toContain('seq');
    expect(names).not.toContain('id');
    db.close();
  });

  it('puts the table on the wire, so nothing here is stranded off it', () => {
    // Named rather than counted: a table dropping out of the contract has to be noticed here, not
    // silently stop being reachable by an app that still has a screen for it.
    expect(BROKER_TABLES as readonly string[]).toContain(TABLE);
  });
});
