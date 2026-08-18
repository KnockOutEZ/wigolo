# Search dispatch conventions

This is the contract `runV1Search` actually implements. The MCP/CLI schema
advertises names; this page is the implicit roster, ranking, and warning
behavior so a vertical change does not silently disagree with `search_engines`.

Applies to `WIGOLO_SEARCH=core` (default). The SearXNG path filters the
`engines[]` seed instead and does not use verticals or `secondary`.

## 1. Vertical → which engines run

Intent picks a vertical, then the vertical's `get*Engines()` roster is the
default pool.

`category` on the tool input is a hard hint — it wins over query text.
Without a hint, classification is first-match:

`papers` → `code` (hard tokens, or language + how-to) → `docs` (phrases,
unless the query has a strict error token) → `news` (date bound, news
keywords, or a parsed date hint) → `general`.

`images` is never inferred from text. It only runs when the caller passes
`category: "images"`.

Each vertical file (`core/verticals/*.ts`) is the source of truth for *who
runs*. An adapter may appear in more than one vertical with different
`weight` / `secondary` / `probeOnly`. Key-gated engines (`brave`,
`brave-image`) join the live pool only when `BRAVE_API_KEY` is set;
`rss-feed` joins news only when feeds are configured. `probeOnly` engines
(Mojeek by default) are held out of the primary wave and pulled only by
degraded-recovery — unless `search_engines` names them.

Date bounds do **not** drop date-naive engines. They still dispatch; dated
engines get `fromDate`/`toDate`, everyone else is freshness-filtered
client-side.

A non-`general` / non-`images` vertical that fuses 1–2 results backfills
from the general pool (`starvation_redispatch`). An explicit
`search_engines` allowlist **skips** that backfill: the caller excluded
those engines.

`research` / `agent` / `find_similar` do not use this catalog. They search
the process `engines[]` seed (`createKeylessDirectEngines` plus plugins).
Plugin search engines therefore do not join core `search` dispatch and
cannot be selected via `search_engines` on core.

## 2. `secondary`

`EngineEntry.secondary` is a **ranking** flag, not a skip. The engine still
runs. After RRF, a URL contributed *only* by secondary engines is multiplied
by `0.3` when its lexical alignment with the query is `< 0.5`. High-alignment
secondary hits keep full score. A URL seen by any primary engine is never
penalized, even if secondaries also returned it.

That is the whole mechanism. It exists so a vertical can admit a useful but
narrow source without letting it dominate off-topic queries:

| Vertical | Primary | Secondary (and why) |
| --- | --- | --- |
| general | bing, ddg, wikipedia, brave | mojeek, marginalia — independent/long-tail indexes, sparse snippets |
| news | hn-algolia, lobsters, bing_news, rss-feed | ddg, mojeek — web recall without outvoting the news sources |
| code | github-code, stackoverflow, devdocs, ddg, brave | mdn, crates-io — real on JS/Rust queries; hijack "pgvector" otherwise |
| docs | mdn, devdocs | bing, ddg — web recall when first-party docs APIs miss the subject |
| papers, images | all primary | — |

Same adapter, different flag across verticals is intentional (DDG is
primary in general/code, secondary in news/docs). Do not "fix" that.

Not the same knob: `quality` weights RRF fusion; `probeOnly` holds dispatch
back; `disabled` parks an adapter. None of those are `secondary`.

## 3. `search_engines` override

Caller string[] of adapter `name`s. Empty / omitted → default pool.

1. Normalize: trim, lowercase, drop empties, dedupe (first spelling wins).
2. Resolve each name against the **current vertical's live roster first**,
   then the cross-vertical catalog (registration order: general, news, code,
   docs, papers, images; first `name` wins). Matching is live adapters, not
   the schema catalog — a catalog name that is not in this process (no Brave
   key, no RSS feeds) is unmatched.
3. **Some names match** → only those engines run, in allowlist order.
   Cross-vertical pull is allowed (`search_engines: ["stackoverflow"]` on a
   general query still classifies as `general`, but only SO dispatches).
   `probeOnly` hold-back is lifted. Starvation backfill is skipped.
   The selected `EngineEntry` keeps the `secondary` / `weight` of the roster
   it was taken from (current vertical if present, else first catalog hit).
4. **No name matches** → the vertical's default pool runs anyway (SearXNG
   fallback shape). This is `allowlistFallback`. The search does not fail.

`core/engine-catalog.ts` (`BUILTIN_ENGINES_BY_VERTICAL`) is the env-independent
name list shared by the MCP/CLI/OpenAPI schema and warning hints. Adding an
engine to a vertical without updating the catalog fails the drift test.
Doctor prints the *live* pool (keys, breakers, plugins on other paths).

## 4. Unknown names → `engine_warnings`

Unmatched allowlist names never fail the call. They become top-level
`engine_warnings` (plus a stderr log).

| Situation | `code` | `message` |
| --- | --- | --- |
| Typo / unknown / not in the live pool, and some other name matched | `unknown_engine` | `unknown engine '…'; ignored` |
| Same, and *nothing* matched (default pool ran) | `unknown_engine` | `unknown engine '…'; no match, using the default pool` |
| Name is a key-gated engine missing from the live pool (`brave`, `brave-image`) | `needs_key` | `engine '…' is not in the active pool` |

`unknown_engine` carries `hint` from `formatEngineCatalogHint()` (built-in
names by vertical + `wigolo doctor`). `needs_key` wins over `unknown_engine`
so requesting `brave` without `BRAVE_API_KEY` is diagnosed as a missing key,
not a typo. `github-code` stays in the live pool without a token; a 401 from
dispatch is a separate `http_401` warning with the `WIGOLO_GITHUB_TOKEN` hint.

Dispatch failures (`http_*`, `timeout`, `dns`, `error`) are a different
pipeline (`buildEngineWarnings` over telemetry). Skipped engines do not warn.

## Adding an engine

1. Adapter under `src/search/engines/` with a stable `name`.
2. Register it in the vertical file(s) with `quality`, and `secondary` /
   `probeOnly` / `supportsDateFilter` if those contracts apply.
3. Add the name to `BUILTIN_ENGINES_BY_VERTICAL` for every vertical that
   registers it. Key-gated / opt-in names belong in the catalog even when
   they are absent from the live pool.
4. If it needs a key: `ENGINE_AUTH_HINTS` + doctor's `KEY_REQUIRED`.
   `registeredWithoutKey: false` engines are unmatched until the key is set
   (`needs_key` on allowlist). `true` engines dispatch and 401 later.
