-- SD9 §3 (3ag, A-420-4/A-420-5) — the reading queue.
--
-- The QUEUE only. Notes are NOT here: "17 snippets, every one keeps its source URL, element and
-- frame" is exactly the merged clip artifact, which already stores all three, so a note or snippet
-- column here would be the second home for them that law 1 forbids (A-420-5). summary is not that
-- — it is a derived line ABOUT a queued page, never captured text from it.
--
-- id is an INTEGER PRIMARY KEY — a rowid alias — and it is the one deliberate difference from the
-- site-profile and widget tables, which take no wire cursor at all. The broker ranges since/before
-- over seq, else an INTEGER id, and offers no cursor to a table without one; a reading queue is the
-- single SD9 store that grows without bound in append order, so paging it by a narrowing where plus
-- a client-side slice — the way those TEXT-keyed listings page — would eventually ask for a whole
-- reading history in one frame and meet MAX_BROKER_ROWS. A rowid alias makes that cursor the
-- insertion order itself and costs no extra column.
--
-- No UNIQUE on url, deliberately. Whether re-saving a page a run already queued is the same item
-- resurfacing or a second entry is a queue SEMANTIC, and semantics belong to the domain module
-- (D8); a constraint here would decide it for every future build and turn the archived-then-re-added
-- case into a wire error rather than a choice.
--
-- added_by carries either the literal human or the id of the run that saved the row — the
-- attribution the surface reads back as "3 more from run 9k1x". One TEXT column rather than a
-- kind/id pair because a run id is already unambiguous against that literal, and core never learns
-- which run ids exist: law 1 keeps the run itself in the run store. No CHECK on it, or on state,
-- for migration 023/024's stated D15/D8 reason.
--
-- summary is NULLABLE and that is load-bearing: the summary is produced locally on save and the
-- local model may simply not be there, in which case the save must still succeed (SD9-B4). A NOT
-- NULL would make summarise-on-save a precondition of saving at all, so an unavailable model would
-- silently cost the user the item. Which shape the absent-with-reason cell takes is the domain
-- module's to choose; core owes the column that can be empty.
--
-- claims_flagged is a COUNT, not the claims. Claim bodies and their verdicts belong to the
-- claim-check layer (3aa) keyed by url, and copying them here would be a second home for them
-- again; the queue listing needs only the badge, which a count renders without parsing anything.
CREATE TABLE IF NOT EXISTS studio_reading_queue (
  id              INTEGER PRIMARY KEY,
  url             TEXT NOT NULL,
  title           TEXT,
  added_by        TEXT NOT NULL,
  summary         TEXT,
  claims_flagged  INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'queued',
  added_at        INTEGER NOT NULL
);

-- The queue as the reading rail opens it: what is still queued, in the order it arrived. Ends in
-- added_at so the listing is the same traversal as the seek and no sort step survives — the trade
-- migrations 019 and 023 make for their own status-scoped listings.
CREATE INDEX IF NOT EXISTS idx_studio_reading_queue_state
  ON studio_reading_queue(state, added_at);

-- The attribution walk: what did this run add, which is the line rendered under an agent-saved row
-- and the question archiving a run's contributions has to ask first. The state index cannot serve
-- it — that index leads on state, and a run's rows are spread across every state.
CREATE INDEX IF NOT EXISTS idx_studio_reading_queue_added_by
  ON studio_reading_queue(added_by, added_at);
