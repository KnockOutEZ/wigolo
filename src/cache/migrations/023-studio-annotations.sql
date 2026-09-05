-- SD4 §4.1 (A-15-4) — the annotation layer: the durable half of what a mark IS. mark/store.ts
-- has always been an in-memory array whose own header says "durable capture is Phase 4"; this is
-- that store. Rows are per URL PATTERN rather than per URL so an annotation survives the query
-- string it was made under, and per PATTERN rather than per element so it survives a re-render:
-- element identity lives in target as a HealSeed the existing heal() re-anchors on revisit.
--
-- Append-plus-status, never an in-place edit. A revise writes a NEW row carrying supersedes and
-- flips the old row's status to 'archived' — the A-16-8 pattern studio_memories already ships,
-- for the same reason: the superseded wording is the record of what a person once meant, and an
-- UPDATE that rewrote body would collapse the chain into a claim no surface can check. status
-- is the ONLY column any write may change after insert.
--
-- Two nullable payload columns, not one blob. target (JSON HealSeed) carries the element-anchored
-- kinds and region (JSON {rects|strokes} in page CSS px) the region kinds; a row uses one or the
-- other, and keeping them apart is what lets a reader tell an unanchored annotation from a
-- region one without parsing either. body is the human text — note text, label string, assert
-- predicate JSON — and is NULL for the kinds that carry no words.
--
-- No CHECK on kind, author or status, deliberately. D15 makes a released migration's text
-- history: a CHECK freezing today's eight kinds into the file would make the ninth a table rebuild
-- on every existing database, and the broker is dumb by design (D8) — an app one migration ahead of
-- the core it paired into must be able to write a kind this core has never heard of. The closed set
-- lives in the domain module that owns these semantics, where it can move.
--
-- Values never enter this table. Targets are HealSeeds and bodies are human text, so a masked
-- input's value has nothing to ride in on (§4.4); credential contexts refuse annotation creation
-- outright, one layer up.

CREATE TABLE IF NOT EXISTS studio_annotations (
  id            TEXT PRIMARY KEY,
  url_pattern   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  target        TEXT,
  region        TEXT,
  body          TEXT,
  author        TEXT NOT NULL,
  author_driver TEXT,
  source_run_id TEXT,
  created_at    INTEGER NOT NULL,
  supersedes    TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
);

-- The layer read: "what is on this page right now", newest last. Ends in created_at so the listing
-- order is the same traversal as the seek and no sort step survives.
--
-- kind is NOT in this index, and that is the trade rather than an oversight: putting it third
-- would serve the policy-kind filter but push created_at behind it, so the ordinary whole-layer
-- listing — the one every page open pays — would sort. A page's annotation set is small, so kind
-- is a residual over an already-seeked range.
CREATE INDEX IF NOT EXISTS idx_studio_annotations_url
  ON studio_annotations(status, url_pattern, created_at);

-- The provenance walk: "what superseded this row". Partial because the overwhelming majority of
-- rows were never revised, so a full index would charge every insert for a column almost no row
-- fills — the same trade migration 019 makes for expires_at.
CREATE INDEX IF NOT EXISTS idx_studio_annotations_supersedes
  ON studio_annotations(supersedes)
  WHERE supersedes IS NOT NULL;
