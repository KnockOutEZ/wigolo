-- SD9 §3 (3af, A-420-3/A-420-4) — declarative site widgets.
--
-- v1 is DECLARATIVE, never script: a widget is a selector to bind to, a set of extract-expressions,
-- and a template that renders the computed values as overlay chips beside each bound element (a
-- unit price per kg, say). Page data is never executed (pin 7), and law 12 holds structurally here
-- rather than by convention — a widget computes from page data and renders chrome-side, so it can
-- neither click, type, navigate nor grant, and there is no column through which it could. That
-- absence is load-bearing because a stored widget is exportable (A-17-4: edit/share is the
-- site-profile export path), so a column that could carry an instruction would carry it off-machine.
--
-- binds and fields are opaque cells because core does not own the extract-expression grammar: the
-- recipe class lives in the domain module (SD9-P1), and a core that parsed it here would owe a new
-- migration every time that grammar gained a form (D8).
--
-- The key is (domain, name): a widget is named within a site, and "authored once" then edited means
-- the same name arriving again is an EDIT of that widget rather than a second one beside it. A
-- surrogate id would let a re-author silently double the chips on every bound element.
--
-- enabled defaults to 1 because authoring passes an element-anchored approval card before anything
-- is stored (§7 approvals): a widget that exists was approved, so a row that arrived without an
-- explicit flag is a live widget, not a dormant one. INTEGER because SQLite has no boolean, and no
-- CHECK on it, for migration 023/024's stated D15/D8 reason.
--
-- No index beyond the primary key's own, deliberately. The read every page load pays is "the
-- enabled widgets for this domain", and the key's index already makes the domain half a seek;
-- enabled is a residual over a range holding one site's widgets, which is a handful of rows. An
-- index bought for that filter would be paid for by every authoring write to save a scan nobody runs.
--
-- The key is TEXT throughout, so this table has NO wire cursor: the broker ranges since/before over
-- an INTEGER seq or id, and a site's widget set is small and read whole on load, so it needs none.
CREATE TABLE IF NOT EXISTS studio_site_widgets (
  domain      TEXT NOT NULL,
  name        TEXT NOT NULL,
  binds       TEXT NOT NULL,
  fields      TEXT NOT NULL,
  template    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (domain, name)
);
