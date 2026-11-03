# Arabic query normalization

wigolo normalizes Arabic queries before they are sent to the search engines.

## The problem

An Arabic question is mostly scaffolding. The user writes

> من هي ذات النطاقين وماذا تعرف عنها؟

("Who is the Lady of the Two Horizons, and what do you know about her?")

but the *answerable* part is only `ذات النطاقين`. Sent verbatim, the leading
preposition `من` ("from/who") is what the engines actually match on — and
`من` is also a letter of the Arabic alphabet, so the top results are
encyclopedia articles about the letter "من" rather than about the person the
user asked for. The same happens with `ما`, `كيف`, `حدثني عن`, and every other
question wrapper.

## The behaviour

For a query that is written in Arabic, wigolo strips:

1. the leading question scaffolding — `من هو`, `من هي`, `مين`, `حدثني عن`,
   `ما اسم`, `من فضلك`, `لو سمحت`, …;
2. the trailing scaffolding — `وماذا تعرف عنها؟`, `وكيف حالك؟`, `أخبرني`, …;
3. common Arabic function words from the body (`في`, `على`, `مع`, `هو`, …).

The stripped query is what the engines receive:

| User query | Sent to the engines |
| --- | --- |
| `من هي ذات النطاقين وماذا تعرف عنها؟` | `ذات النطاقين` |
| `من هو مؤسس الجيش المصري الحديث` | `مؤسس الجيش المصري الحديث` |
| `من هو بطل الحرب والسلام؟` | `بطل الحرب والسلام` |
| `machine learning papers 2024` | unchanged (not Arabic) |

Two safety rules keep the cleaner from ever hurting a query:

- if stripping would leave less than three characters, the pre-strip form is
  used instead — a query is never emptied;
- non-Arabic queries are a strict no-op: the cleaner only runs when Arabic
  characters dominate the query (≥ 50% of the letters).

## Where it happens

Normalization runs at the search dispatch boundary, so it applies to every
search path (the `search` tool, the research pipeline, the REST API) without
callers having to opt in. The **original** wording is still what the
response echoes back, so downstream consumers still see the question exactly
as it was asked — the contract differs per tool:

- **`search`** echoes the original wording in the response's `query` field.
- **`research`** has no `query` field: the wording it was given is kept in
  `input.question`, and the individual normalized sub-queries are reported in
  `sub_queries`.

The cleaner itself lives in `src/search/arabic/query-cleaner.ts` and is
exposed through `preprocessQueryForSearch()` in `src/search/query.ts`.

## Tests

`tests/unit/search/arabic/query-cleaner.test.ts` covers the detection, the
leading/trailing scaffolding, the body stopwords, and the two safety rules
(no empty query, no over-stripping).
