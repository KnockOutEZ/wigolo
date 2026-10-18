# DeepSeek search engine plugin

A `searchEngine` plugin that queries DeepSeek's search API (`POST
https://api.deepseek.com/v1/tools/search`) and maps its results onto wigolo's
`RawSearchResult` shape. `maxResults` becomes the API's `count`; `rerank_score`
(0-3) divides by 3 into wigolo's 0-1 scale.

`wigolo plugin add` accepts a git URL only, so from the repository root link
this directory into your plugins dir and validate it:

```bash
ln -s "$PWD/examples/plugin-deepseek-search" ~/.wigolo/plugins/deepseek-search
wigolo plugin validate
```

`DEEPSEEK_API_KEY` must be set in the server environment
(`WIGOLO_DEEPSEEK_ENDPOINT` overrides the endpoint, and the request deadline
defaults to 10 seconds). Plugin engines join the fan-out on the `searxng` and
`hybrid` tiers, where every registered engine gets at least one query per
fan-out search. `mode: "cache"` dispatches a single engine instead, and the
default `core` backend builds its pool from built-in verticals, so neither
reaches a plugin engine.
