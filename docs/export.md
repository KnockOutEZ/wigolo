# Exporting your corpus

Everything wigolo caches lives in a SQLite database in `~/.wigolo`. That is an implementation
detail, not a lock-in: `wigolo export` writes the whole thing out as plain Markdown files with
a JSON index, and the result needs no wigolo — or any other tool — to read.

```bash
wigolo export --out ./my-corpus
```

```text
[wigolo export] reading cache…
[wigolo export] done: scanned=4 exported=3 skipped=1 anomalies=0 out=./my-corpus
```

## What you get

```text
my-corpus/
├── README.md                              explains the layout, inside the export itself
├── manifest.json                          the index
└── pages/
    ├── 2026-07-02/
    │   └── docs.example.com-api.md
    └── 2026-08-11/
        ├── docs.example.com-guide.md
        └── blog.example.com-post.md
```

Pages are filed under the date they were fetched, so the corpus reads chronologically — which
snapshot of a page you are holding is visible from the directory tree, before you open anything.

## A page file

Every file opens with a YAML front-matter block, then the page content as Markdown:

```markdown
---
url: "https://docs.example.com/guide"
title: "The Guide"
fetched_at: "2026-08-11T09:00:00.000Z"
content_hash: "aaa111"
http_status: 200
fetch_method: "http"
partial: false
---
# The Guide

How to do the thing.
```

The provenance travels with the file. One `.md` mailed to a colleague, with no manifest and no
directory around it, still says where it came from and when.

| Field | Meaning |
| --- | --- |
| `url` | The page's source URL. This is the authoritative identifier — filenames are a convenience. |
| `title` | The extracted page title, or `null` if there wasn't one. |
| `fetched_at` | When wigolo retrieved this version. |
| `content_hash` | Hash of the content, for comparing versions across two exports. |
| `http_status` | The upstream HTTP status at fetch time. `null` on pages cached before wigolo recorded it. |
| `fetch_method` | `http` or `browser` — whether the page needed the browser engine to render. |
| `partial` | `true` when the browser engine captured the page before it finished rendering. The content is real, but known to be incomplete. |

Every value is read straight from the cache. Nothing is inferred, and a field the cache does not
have exports as `null` rather than a plausible-looking guess.

## The manifest

`manifest.json` is the index — the same provenance fields per page, plus each page's path in the
directory, and an honest account of what was *not* exported:

```json
{
  "schema_version": 1,
  "exported_at": "2026-08-11T06:15:59.914Z",
  "source": { "data_dir": "/Users/you/.wigolo" },
  "filters": { "url_pattern": null, "since": null },
  "counts": { "scanned": 4, "exported": 3, "skipped": 1, "anomalies": 0 },
  "pages": [
    {
      "url": "https://docs.example.com/guide",
      "normalized_url": "https://docs.example.com/guide",
      "title": "The Guide",
      "fetched_at": "2026-08-11T09:00:00.000Z",
      "content_hash": "aaa111",
      "http_status": 200,
      "fetch_method": "http",
      "bytes": 34,
      "partial": false,
      "path": "pages/2026-08-11/docs.example.com-guide.md"
    }
  ],
  "skipped": [
    { "url": "https://docs.example.com/empty", "reason": "empty_content" }
  ]
}
```

### Skipped rows

A cached row with no extracted text is **not** written out as an empty file — an empty file
looks like a page that had nothing to say, which is a different claim from "we cached this URL
but got no content". It is listed under `skipped` instead:

| Reason | What it means |
| --- | --- |
| `empty_content` | The row exists in the cache but holds no extracted text. Common for redirects, `204`s, and pages the extractor could make nothing of. |
| `fence_marker_in_stored_content` | The stored value carried a containment marker that should never be written to the cache. These rows are reported rather than exported, and `wigolo export` exits `1` so a scripted export cannot pass over it silently. If you see this, please [open an issue](https://github.com/KnockOutEZ/wigolo/issues). |

## Options

```text
wigolo export [--out DIR] [--url-pattern GLOB] [--since DATE] [--dry-run] [--json]
```

| Flag | Effect |
| --- | --- |
| `--out DIR` | Output directory. Defaults to `./wigolo-export`. Also accepts `--out=DIR`. |
| `--url-pattern GLOB` | Export only pages whose URL matches the glob. |
| `--since DATE` | Export only pages fetched after this date. |
| `--dry-run` | Report exactly what would be written, and write nothing. |
| `--json` | Emit a single JSON summary on stdout. |
| `-h`, `--help` | Print the usage. |

### Scoping an export

Take just one site's documentation:

```bash
wigolo export --out ./docs-corpus --url-pattern 'https://docs.example.com/*'
```

Take everything captured since the start of the month:

```bash
wigolo export --out ./august --since 2026-08-01
```

Both filters combine, and both are recorded in the manifest's `filters` block so an export always
says what it covered.

### Checking before you write

`--dry-run` computes the complete plan — the same page list, the same skip list, the same
counts — and creates nothing:

```bash
wigolo export --out ./my-corpus --dry-run
```

```text
[wigolo export] reading cache (dry-run)…
[wigolo export] done: scanned=4 exported=3 skipped=1 anomalies=0 out=./my-corpus (dry-run — nothing written)
```

### Scripting it

Under `--json`, stdout carries exactly one JSON document and every human-readable line goes to
stderr, so the output pipes cleanly:

```bash
wigolo export --out ./my-corpus --json 2>/dev/null | jq '.exported'
```

```json
{"status":"ok","out_dir":"./my-corpus","scanned":4,"exported":3,"skipped":1,"anomalies":0,"dry_run":false}
```

The exit code is `0` normally and `1` when any row was refused as an anomaly.

## Notes

**Filenames are not identifiers.** They are derived from the source URL and then sanitised down
to a safe, bounded name, so two different URLs can produce similar-looking filenames and a name
alone is never enough to identify a page. The `url` field inside the file is authoritative.

**Exports are additive, not a sync.** Running `export` again into the same directory writes the
current corpus over the top; it does not remove files for pages you have since cleared from the
cache. Export into a fresh directory when you want an exact snapshot.

**Large corpora are streamed.** Pages are read and written one at a time, so exporting tens of
thousands of cached pages does not need to hold them in memory.

## See also

- [CLI reference](./cli.md) — every command and the `--json` contract.
- [Privacy & security](./privacy-security.md) — what lives on disk and what leaves your machine.
- [Tools](./tools.md#cache) — querying the cache in place, without exporting it.
