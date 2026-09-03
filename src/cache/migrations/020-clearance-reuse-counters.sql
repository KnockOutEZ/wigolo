-- SD6 §10 — the clearance reuse ledger's storage half.
--
-- Core already persists one anti-bot clearance per host (008) and the egress
-- route it was minted on (010), but nothing records how much value that solve
-- went on to produce. The site-profile card states it as
-- "solved this wall 2026-08-12 · reused 14×", so the ledger needs the solve
-- instant and a reuse tally that belongs to THAT solve.
--
-- Three nullable/defaulted columns on domain_routing, the table the clearance
-- already lives on — a separate table would be a second source of truth for a
-- row that is already 1:1 with a host.
--
--   clearance_solved_at  ISO instant the current clearance was recorded.
--                        NULL on pre-020 rows; the read projection falls back
--                        to last_updated for those, which is the closest
--                        instant those rows carry.
--   reused_count         reuses of the CURRENT clearance. Reset to 0 by every
--                        fresh solve and by every purge, because the count is
--                        a property of one clearance, not of the host.
--   last_reused_at       ISO instant of the most recent reuse; NULL until the
--                        first one.
--
-- The cookie value itself is untouched here and is structurally absent from
-- the read API these columns exist to serve.
--
-- This .sql file is a grep-mirror only — the runner.ts MIGRATIONS[] entry
-- (postStep-guarded on PRAGMA table_info, since SQLite has no
-- `ADD COLUMN IF NOT EXISTS`) is what actually runs.

ALTER TABLE domain_routing ADD COLUMN clearance_solved_at TEXT;
ALTER TABLE domain_routing ADD COLUMN reused_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE domain_routing ADD COLUMN last_reused_at TEXT;
