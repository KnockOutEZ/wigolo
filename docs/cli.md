# CLI reference

The `wigolo` binary is four things: an MCP server (the default, when run with no arguments), a set of management commands, five account verbs, and a one-shot runner for all ten tools.

```text
wigolo                  Start MCP server on stdio (default)
wigolo <command>        Run a subcommand
wigolo <tool> <args>    Run a tool once (headless)
```

`wigolo --help` prints the full map. Every tool and most subcommands accept `--help` too — the exceptions are `doctor`, `status`, `health`, `warmup` and the five [account verbs](#your-wigolo-account), which ignore the flag and just run. On `wigolo logout` that means `--help` signs you out, so read this page rather than asking those five for help.

## The --json contract

Any command or tool run with `--json` emits exactly one machine-readable JSON document on **stdout**. All logs go to **stderr**, always. This means you can pipe wigolo into `jq` or another process without filtering:

```bash
wigolo search "zig comptime" --json 2>/dev/null | jq '.results[].url'
```

## Management commands

### init

```text
wigolo init [--agents=<csv>] [--no-warmup] [--interactive] [--wizard]
            [--json] [--skip-verify] [--plain]
            [--provider=anthropic|openai|gemini|ollama] [--search=core|searxng|hybrid]
```

Unattended by default: wires the agents you name, persists settings, downloads the browser engine and on-device models, verifies them, and prints a per-component report. `--no-warmup` skips all downloads (lazy-load on first use). `--interactive` gives a plain-text prompt flow; `--wizard` the full TUI. An LLM key is only ever read from the `WIGOLO_LLM_API_KEY` env var, never from a flag. See [getting started](./getting-started.md).

### doctor

```text
wigolo doctor [--fix] [--json]
```

Diagnoses the installation: data dir writability, browser engine, fetch tiers, on-device models, LLM provider status, search backend, per-engine health (with the exact env var that enables each keyed engine), cache stats, your [account and activation state](#your-wigolo-account), and whether telemetry is on. `--fix` repairs known failures. Runs on an install that has never registered.

### verify

```text
wigolo verify [--plain] [--json]
```

End-to-end capability smoke check with real network calls. Exit 0 when all capabilities pass or skip; exit 1 when any fails. Like `doctor` and `warmup`, it runs on an install that has never registered — its probes are fixed, not user-chosen.

### status / health

```text
wigolo status [--json]     # install state + connected agents
wigolo health [--json]     # probes the running daemon; exit code = status
```

### config

```text
wigolo config [--plain] [--json] [--set <key>=<value>] [--storage] [--cache-stats]
              [--export [path]] [--import <path>] [--cleanup <component>]
              [--force-wizard] [--uninstall --yes]
```

Interactive settings shell by default. `--set` takes the env-var-style key (`--set WIGOLO_SEARCH=hybrid`); `--plain` lists the accepted keys. `--cleanup` frees storage for `cache|embeddings|models|browser|searxng`. `wigolo dashboard` is an alias. See [configuration](./configuration.md).

`--cache-stats` is currently broken — it reports a database-initialization error rather than the stats. Use `wigolo cache stats` instead.

### setup

```text
wigolo setup mcp [--agents=<csv>]
```

Wires wigolo into MCP clients (the same wiring `init --agents` does, standalone).

### skills

```text
wigolo skills <add|list|remove> [packs...] [--global] [--agent <id,...>] [--dry-run] [--json] [--force]
```

Installs skill packs for your coding agents. Full story in [skills](./skills.md).

### plugin

```text
wigolo plugin add <git-url> [--yes]
wigolo plugin list [--json]
wigolo plugin validate [--json]
wigolo plugin remove <name>
```

See [plugins](./plugins.md).

### tune

```text
wigolo tune <list|show <domain>|reset <domain>|reset --all> [--json]
```

wigolo self-tunes per-domain fetch routing as it works: it promotes the TLS-impersonation tier where that's what succeeds, escalates to the browser engine when needed, reuses solved challenge clearances, and backs off politely after repeated blocks. `tune list` shows what it has learned per domain; `tune reset` clears it (useful when a site changes behavior).

### auth

```text
wigolo auth discover    # list attachable browser debug sessions
wigolo auth status      # current auth configuration
```

Pairs with the session env vars in [configuration](./configuration.md#fetch-and-browser-engine) and `use_auth: true` on fetch/crawl.

> `wigolo auth` is about **sites you sign in to through the browser engine** — it has
> nothing to do with your wigolo account. Your account lives under
> [`wigolo account`](#your-wigolo-account) and its four sibling verbs.

### backfill

```text
wigolo backfill [--dry-run] [--limit N] [--batch-size N] [--json]
```

Computes embeddings for cached pages that don't have them yet (e.g. pages cached before the embedding index existed). Default batch size 32.

### export

```text
wigolo export [--out DIR] [--url-pattern GLOB] [--since DATE] [--dry-run] [--json]
```

Writes the cached corpus out as one Markdown file per page under `DIR/pages/<fetch-date>/`, each carrying its own source URL, fetch time and content hash in front matter, plus a `manifest.json` index and a `README.md` explaining the layout. Plain files, no proprietary format — the export stays readable with wigolo uninstalled. `--out` defaults to `./wigolo-export`. Exits 1 when a cached row is refused as an anomaly. See [export](./export.md).

### warmup

```text
wigolo warmup [--all|--browser|--reranker|--embeddings]
```

Re-runs component downloads — for CI images or repairing a broken component. `init` already does this; you rarely need it directly.

### serve

```text
wigolo serve [--port N] [--host H] [--allow-unauthenticated]
```

Starts the HTTP daemon (REST + remote MCP). It streams protocol output, so there is no `--json` here. Full reference: [REST API](./rest-api.md).

`serve` refuses at start on an install that is not activated, rather than starting and
failing every request — see [Your wigolo account](#your-wigolo-account).

### uninstall

```text
wigolo uninstall [--yes] [--json]
```

Removes agent integrations (MCP config, instructions, skills, slash command). Keeps `~/.wigolo` data; the command prints the full-cleanup path for your install method.

## Your wigolo account

Five verbs, separate from the management commands above because they concern your account
rather than this machine's setup. Not to be confused with [`wigolo auth`](#auth), which
manages site sign-ins for the browser engine.

All ten tools are gated on an activated install. Diagnostics are not: `doctor`, `verify`
and `warmup` run on a machine that has never registered, so a broken install can always be
diagnosed. Everything that reaches a tool — the MCP server, the REST daemon, the
interactive shell, a one-shot tool command — refuses with the same line until you activate:

```text
wigolo needs an account — run `wigolo register` to create one (already have one? `wigolo login`).
```

### register

```text
wigolo register [--email E] [--json]
```

Creates your account and activates this install. It asks for your email address, mails a
sign-in code and waits for you to type it back; then — still before the account exists —
shows what usage and reliability telemetry covers and asks whether you want occasional
product-update emails. No password at any point. If the account service is unreachable
when the disclosure is fetched, registration stops and nothing is created: the wording
being agreed to is served, never bundled into the client, so there is no offline
substitute to show you.

### login

```text
wigolo login [--email E] [--json]
```

Signs an existing account in on this machine, by the same emailed code. Use it on a second
machine, or after `logout`, or when a sign-in expires.

### logout

```text
wigolo logout [--json]
```

Signs out on this machine. Clears the local credential only — other machines stay signed
in and the account itself is untouched.

### whoami

```text
wigolo whoami [--json]
```

Fully offline: answers from cached state, which is what makes it useful on the machine most
likely to be asking. Prints the email, the account id, the activation state, and when the
sign-in expires. Exit 1 when this machine was never activated.

### account

```text
wigolo account [--json]
wigolo account export <file>
wigolo account delete
```

`account` on its own reaches the service for a summary: email, account id, creation date,
product-update-email consent, which telemetry disclosure version you were shown, and
whether telemetry is on. `export` writes everything the service holds for you to a JSON
file. `delete` permanently deletes the account and signs this machine out — it asks you to
type `DELETE` first, and anything else cancels.

Telemetry state is reported here and by `wigolo doctor`; the switch itself is
[`WIGOLO_TELEMETRY`](./configuration.md#account-and-telemetry).

## One-shot tools

All ten tools run headlessly. Tool parameters map 1:1 from the wire names to `--kebab-case` flags (see [tools](./tools.md) for semantics):

```bash
wigolo search <query>       [--max-results=N] [--category=...] [--include-domains=a,b]
                            [--time-range=...] [--exact-match] [--search-depth=...] ...
wigolo fetch <url>          [--render-js=auto|always|never] [--section=H] [--use-auth] ...
wigolo crawl <url>          [--strategy=bfs|dfs|sitemap|map] [--max-depth=N] [--max-pages=N] ...
wigolo extract <url>        [--mode=structured|schema|tables|metadata|selector|brand] ...
wigolo cache stats | cache search <query> | cache clear [--query=Q] [--url-pattern=P]
wigolo find-similar <url-or-concept>  [--max-results=N] [--mode=...] ...
wigolo research <question>  [--depth=quick|standard|comprehensive] [--max-sources=N] ...
wigolo agent <prompt>       [--urls=u1,u2] [--schema=JSON|@file] [--max-pages=N] ...
wigolo diff <url> | diff --old="text" --new="text"  [--output=...] [--granularity=...]
wigolo watch add <url> --interval=SECONDS | watch list | watch rm <id> | watch run <id>
```

JSON-valued flags (`--schema`, `--headers`, `--actions`, `--agent-context`) accept inline JSON or `@file`:

```bash
wigolo extract https://example.com/pricing --mode=schema --schema=@pricing-schema.json --json
```

Note on `watch`: a one-shot process can register and list jobs, but checks only run while a daemon (`wigolo serve`) or MCP session is alive.

## Interactive shell

```bash
wigolo shell
```

A REPL over all ten tools with tab completion and persistent history (`~/.wigolo/shell-history`). One warm process means no per-command startup cost — much faster for exploratory sessions than repeated one-shots.

```text
wigolo> help
  search <query> [--limit=N] [--domains=a,b] ...
  fetch <url> [--max-chars=N] [--section=HEADING]
  crawl <url> [--depth N] [--max-pages N] [--strategy=bfs|dfs|sitemap|map]
  cache search <query> | cache stats | cache clear [--query=Q]
  extract <url> [--mode=...] [--selector=CSS]
  find-similar <url-or-concept> [--limit=N]
  research <question> [--depth=...]
  agent <prompt> [--urls=u1,u2]
  diff <url> [--output=...] [--granularity=...]
  watch add <url> [--interval=SECONDS] | watch list | watch rm <id>

  help          Show this help
  exit          Exit the shell
  .history      Show command history
  .json on|off  Toggle newline-delimited JSON output for tool results
```

### Scripting the shell

The shell reads stdin, so you can pipe a script of commands through one warm process. `--json` (or `.json on`) switches results to newline-delimited JSON — one line per command — and a piped session exits `1` if any command failed, `0` otherwise:

```bash
printf 'search "bun test runner"\nfetch https://bun.sh/docs/cli/test\n' \
  | wigolo shell --json 2>/dev/null \
  | jq -r '.results[]?.url // .url'
echo "exit: $?"
```

[← Docs index](./README.md) · [Next: REST API](./rest-api.md)
