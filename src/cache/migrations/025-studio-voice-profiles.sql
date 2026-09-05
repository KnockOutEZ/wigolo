-- SD9 §3 (3ac, A-420-4) — writing-tone voice profiles.
--
-- NOT speech. §0a.4 defers the voice/audio frame (3ba) post-done and the SD9 mini-spec's §0 rules
-- 3ac distinct from it: these are the profiles behind the LinkedIn · measured / Slack · terse /
-- email · formal chips and the "Match my voice" button. No audio, no capture and no synthesis is
-- implied by any column here; one that implied a stored utterance would be the deferred frame
-- arriving through the schema.
--
-- A profile is learned ONLY from text the user actually wrote on that site — never a generic
-- "professional tone" — so exemplars is NOT NULL: a row with no exemplars IS that generic profile
-- wearing a site's name, and there is no state in which one is wanted. That the learning is an
-- explicit human act ("+ learn from this field", nothing learned silently) is a law-12 control and
-- is NOT here: a table-scoped wire has no actor to test, so it lives in the domain module (SD9-B3).
--
-- domain is eTLD+1, keyed exactly as deriveDomain keys a pre-grant, so a profile spans the same
-- slice of the web as the grant card that authorised reading the text it learned from. surface is
-- the composing surface within that site — a post composer, a DM, an email reply.
--
-- The key is the TRIPLE, not the (domain, surface) pair. compose takes voice_profile?: text, so
-- a NAME is the handle a caller resolves a profile by, and a surface must therefore be able to
-- carry more than one named tone; re-learning the same name on the same surface is that profile
-- arriving again rather than a second one beside it. A pair key would make the second named tone
-- unstorable, and D15 makes that unfixable without a table rebuild on every existing database.
--
-- No CHECK on surface, for migration 023/024's stated reason: D15 makes a released migration's
-- text history, and the broker is dumb by design (D8) — an app one migration ahead of the core it
-- paired into must still be able to write a surface this core has never heard of.
--
-- No column here can carry a credential, structurally rather than by convention: exemplars are text
-- the user typed into a visible field, and a masked input's value never enters a snapshot in the
-- first place (the pinned same-origin stance), so no path reaches this table with a secret on it.
--
-- The key is TEXT throughout, so this table has NO wire cursor: the broker ranges since/before over
-- an INTEGER seq or id, and a caller paging by an opaque TEXT key would walk an order nothing
-- wrote in. Deliberate — a profile set is bounded by the surfaces a person composes on, so it pages
-- by a narrowing where plus a client-side slice, exactly as the site-profile listing does.
CREATE TABLE IF NOT EXISTS studio_voice_profiles (
  domain      TEXT NOT NULL,
  surface     TEXT NOT NULL,
  name        TEXT NOT NULL,
  exemplars   TEXT NOT NULL,
  learned_at  INTEGER NOT NULL,
  PRIMARY KEY (domain, surface, name)
);

-- "Every profile this site has, newest last" — what the profile picker and the privacy dashboard
-- both open with. The primary key's own index seeks by domain but orders by surface, so ordering by
-- recency over it costs a sort on every open; this one ends in learned_at, so the listing is the
-- same traversal as the seek and no sort step survives.
CREATE INDEX IF NOT EXISTS idx_studio_voice_profiles_domain
  ON studio_voice_profiles(domain, learned_at);
