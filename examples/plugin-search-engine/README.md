# Minimal search engine plugin example

A tiny, copyable `searchEngine` plugin that queries the [Hacker News
Algolia API](https://hn.algolia.com/api) — free, keyless, and a plain JSON
endpoint — and maps results onto wigolo's search result shape.

## Install

```bash
wigolo plugin add /path/to/examples/plugin-search-engine
# or, once this lives in its own repo:
wigolo plugin add https://github.com/you/your-search-plugin
```

`wigolo plugin add` copies the directory into wigolo's plugins directory
(`$WIGOLO_PLUGINS_DIR`, default `<dataDir>/plugins/<name>`). On the next
`loadPlugins()` pass (server start, or `wigolo plugin list`/reload) the
loader picks it up automatically — no registration step required.

## Contract surface

This is the minimum the plugin loader (`src/plugins/loader.ts`) and
validator (`src/plugins/validate.ts`) require:

- **`package.json`** must have a `main` field pointing at the plugin's
  entry point (relative path, resolved from the plugin directory). `name`
  and `version` are read for display/registry bookkeeping but aren't
  otherwise validated.
- **Entry point** (`index.mjs` here) must be an ES module the loader can
  `import()` directly — no build step, no bundler.
- **Named export `searchEngine`**, matching the `SearchEngine` interface:
  - `name: string` — non-empty, must be unique across all loaded plugins
  - `search(query: string, options?: SearchEngineOptions): Promise<RawSearchResult[]>`

  Each `RawSearchResult` needs at least:
  `{ title, url, snippet, relevance_score, engine }` (`relevance_score` in
  `[0, 1]`; `engine` should match `searchEngine.name`). Optional fields like
  `published_date` are passed through untouched.

- A plugin may *additionally* export an `extractor` (see
  `src/types.ts#Extractor`) from the same entry point — the loader
  registers whichever of `extractor` / `searchEngine` it finds — but this
  example only implements `searchEngine`.

Anything exported beyond `extractor`/`searchEngine` is ignored. A module
that exports neither (or exports something that fails shape validation)
is rejected with a descriptive error and simply skipped — it won't crash
the server.

## Files

- `package.json` — points `main` at `index.mjs`
- `index.mjs` — exports the `searchEngine` object; calls the HN Algolia
  `/search` endpoint with `tags=story`, maps hits to
  `{ title, url, snippet, relevance_score, engine, published_date }`

## Try it standalone

No wigolo runtime needed to sanity-check the plugin itself:

```bash
node -e "
import('./index.mjs').then(async ({ searchEngine }) => {
  const results = await searchEngine.search('agentic coding', { maxResults: 3 });
  console.log(results);
});
"
```
