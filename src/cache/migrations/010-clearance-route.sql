-- Extend domain_routing with the egress route a clearance was solved on.
-- A cf_clearance is bound to the {IP + UA + TLS} of the egress it was minted
-- against (FlareSolverr #871): a clearance harvested on one route is invalid
-- from another. `solved_route` records that egress (`proxyUrl ?? 'direct'`) at
-- harvest so reuse can HARD-REFUSE on a route mismatch. Legacy pre-010 rows
-- carry NULL and are read back as 'direct'.
--
-- This .sql file is a grep-mirror only — the runner.ts MIGRATIONS[] entry
-- (postStep-guarded on PRAGMA table_info, since SQLite has no
-- `ADD COLUMN IF NOT EXISTS`) is what actually runs.

ALTER TABLE domain_routing ADD COLUMN solved_route TEXT;
