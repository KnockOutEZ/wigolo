-- Extend domain_routing with anti-bot clearance
-- state. When a challenge (e.g. a Cloudflare interstitial) is solved for a
-- domain, the resulting clearance cookie + the exact user-agent it was minted
-- against + the fetch tier that solved it are recorded so subsequent visits
-- can replay the clearance instead of re-solving. `backoff_until` / `last_403_at`
-- track a per-domain cooldown after repeated blocks so we stop hammering a
-- host that is actively refusing us.
--
-- The base `domain_routing` table is normally created inline in
-- src/cache/db.ts before migrations run. For raw-applyMigrations callers
-- (tests, ad-hoc tools) the CREATE here is the safety net so the ALTERs
-- never reference a missing table.

CREATE TABLE IF NOT EXISTS domain_routing (
  domain TEXT PRIMARY KEY,
  prefer_playwright INTEGER DEFAULT 0,
  http_failures INTEGER DEFAULT 0,
  last_updated TEXT
);

ALTER TABLE domain_routing ADD COLUMN cf_clearance TEXT;
ALTER TABLE domain_routing ADD COLUMN clearance_ua TEXT;
ALTER TABLE domain_routing ADD COLUMN clearance_tier TEXT;
ALTER TABLE domain_routing ADD COLUMN clearance_expires_at TEXT;
ALTER TABLE domain_routing ADD COLUMN backoff_until TEXT;
ALTER TABLE domain_routing ADD COLUMN last_403_at TEXT;
