# DeepSeek search engine plugin

A `searchEngine` plugin that queries DeepSeek's search API (`POST
https://api.deepseek.com/v1/tools/search`) and maps its results onto wigolo's
`RawSearchResult` shape. `maxResults` becomes the API's `count`; `rerank_score`
(0-3) divides by 3 into wigolo's 0-1 scale.

`wigolo plugin add` accepts a git URL only, so link this directory into your
plugins dir and validate it:

```bash
ln -s "$PWD/examples/plugin-deepseek-search" ~/.wigolo/plugins/deepseek-search
wigolo plugin validate
```

`DEEPSEEK_API_KEY` must be set in the server environment
(`WIGOLO_DEEPSEEK_ENDPOINT` overrides the endpoint). The plugin loads and
registers like any other engine, but no backend dispatches plugin engines
today: `core` builds its pool from built-in verticals, and the `searxng` and
`hybrid` tiers fan out only the engines their own path constructs. Expect the
plugin to appear in startup logs and in `wigolo plugin list`, not in
`engines_used`.
