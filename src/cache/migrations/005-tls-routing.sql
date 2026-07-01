-- Extend domain_routing with TLS-impersonation
-- learning columns. When the TLS-impersonation tier succeeds for a domain N
-- times (default 3), `prefer_tls_impersonation` flips to 1 so the next visit
-- skips the HTTP attempt and tries the TLS tier first.
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

ALTER TABLE domain_routing ADD COLUMN prefer_tls_impersonation INTEGER DEFAULT 0;
ALTER TABLE domain_routing ADD COLUMN tls_success_count INTEGER DEFAULT 0;
