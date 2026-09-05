-- SD6 §3 (A-17-3) — the site-profile store: a JUNCTION over things that already have a home,
-- never a second home for them. Brief spine 4 lists labels + fences + redactions + assertions +
-- memories + view rules + widgets for a site, but SD4 already ships the first four as
-- studio_annotations rows keyed by url_pattern and SD5 ships memories standalone. Copying either
-- here would create the second source of truth law 1 forbids, so the profile row carries only what
-- is genuinely per-domain and nothing else: annotations are read through the SD4 store filtered by
-- domain, memories are referenced by id through the junction below, and clearance is read through
-- core's per-host ledger over the companion seam.
--
-- domain is eTLD+1, keyed exactly the way deriveDomain keys a pre-grant, so "remember for this
-- site" means the same span of the web in the grant card and in the profile card.
--
-- No CHECK on visibility or writer, deliberately, and for migration 023's stated reason. D15 makes
-- a released migration's text history: a CHECK freezing today's three visibility modes into this
-- file would make the fourth a table rebuild on every existing database, and the broker is dumb by
-- design (D8) — an app one migration ahead of the core it paired into must still be able to write.
-- The closed sets live in the domain module that owns these semantics, where they can move.
--
-- No column here can carry a credential. There is no cookie, password, token or clearance field in
-- any of the three tables, and that is structural rather than a convention: a profile is portable
-- (§3's export/import) and a clearance value is UA/route-bound, so a clearance column would turn an
-- exported profile into a portable auth artifact. Clearance stays read-through, never copied.

-- The profile row itself. run_count is a maintained fold, not a derivation: the runs that touched a
-- domain are not enumerable from here (law 4 keeps a run's tabs to its run) and the counter is what
-- the profile card shows. There is no atomic-increment path and none is wanted — BrokerWriteOp.row
-- binds literal cells with no expression language, so the fold is a read-modify-write serialised
-- per domain by the domain module.
--
-- domain is the PRIMARY KEY and it is TEXT, so this table has NO wire cursor: the broker's
-- since/before range over an INTEGER seq or id, and a caller paging by an opaque TEXT key would
-- walk an order nothing wrote in. That is deliberate — the profile listing pages by a narrowing
-- where plus a client-side slice, exactly as the memories layer does.
CREATE TABLE IF NOT EXISTS studio_site_profiles (
  domain      TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  run_count   INTEGER NOT NULL DEFAULT 0,
  visibility  TEXT NOT NULL DEFAULT 'full',
  view_rules  TEXT,
  flags       TEXT
);

-- The PERSISTENT half of "remember for this site" — the layer that seeds the session PreGrantStore
-- at session start rather than replacing it. writer is recorded because a grant is a human act at
-- this store (the same AgentWriteRefusedError posture the auth-origin ledger holds); the store
-- cannot enforce that, since a table-scoped wire has no actor to test, so the refusal lives one
-- layer up and this column is the record of who claimed it.
CREATE TABLE IF NOT EXISTS studio_site_grants (
  id          TEXT PRIMARY KEY,
  domain      TEXT NOT NULL,
  scope       TEXT NOT NULL,
  granted_at  INTEGER NOT NULL,
  writer      TEXT NOT NULL
);

-- The read every grant card and every profile card pays: "what has this domain been granted",
-- newest last. Ends in granted_at so the listing order is the same traversal as the seek and no
-- sort step survives.
CREATE INDEX IF NOT EXISTS idx_studio_site_grants_domain
  ON studio_site_grants(domain, granted_at);

-- The junction (A-16-9 executed): a profile REFERENCES a memory by id and embeds it only at export.
-- Composite primary key rather than a surrogate id because the pair IS the fact — linking the same
-- memory to the same domain twice is the same link, not a second one, and a surrogate key would let
-- a retried write say otherwise. No foreign key to studio_memories: the two tables are written by
-- the same app across two migrations that may land in either order (D8), and a constraint that
-- refuses the link would lose the user's action rather than defer it.
CREATE TABLE IF NOT EXISTS studio_site_memories (
  domain     TEXT NOT NULL,
  memory_id  TEXT NOT NULL,
  linked_at  INTEGER NOT NULL,
  PRIMARY KEY (domain, memory_id)
);

-- The reverse walk the composite key cannot serve: "which sites reference this memory", which is
-- what deleting a memory has to ask before it can say what it is about to change. The forward
-- direction is already the PK's own index.
CREATE INDEX IF NOT EXISTS idx_studio_site_memories_memory
  ON studio_site_memories(memory_id);
