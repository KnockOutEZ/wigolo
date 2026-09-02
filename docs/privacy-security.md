# Privacy & security

wigolo's privacy model is structural, not a policy promise: the software runs on your
machine, stores on your disk, and the only thing it can report is a closed list of counters
that page content, queries and URLs are not representable in.

As of 0.3.0 there is one vendor backend — the account service that activates your install
and receives usage and reliability telemetry. What it can receive is bounded by the code,
not by a promise, and the telemetry half is a single switch away from silent. Both are
below.

## Everything stays local

The whole state of a wigolo install lives in the data dir (`~/.wigolo` by default):

| Path | Contents |
| --- | --- |
| `wigolo.db` | The knowledge cache: pages, search results, full-text + vector indexes. |
| `jobs.db` | Watch jobs. |
| model caches | The on-device embedding and ranking models (two directories, created at `init`/`warmup`). |
| `config.json` | Non-secret settings (secrets are excluded by design — see below). |
| `keys/` | Encrypted credential files, only when the OS keychain isn't available — LLM keys, and the account refresh token as `account.enc`. |
| `plugins/` | Installed [plugins](./plugins.md). |
| `skills/receipts.json` | The [skills](./skills.md) install ledger. |
| `shell-history` | Interactive shell history. |
| `account/state.json` | Your account id and email, the entitlement token, and refresh metadata. Owner-only permissions (`0600`). No account secret is stored here. |
| `telemetry/` | Events waiting to be sent — a capped `queue.ndjson` plus short-lived batch files while a send is in flight. Absent while telemetry is off. |
| `searxng/` | The optional legacy aggregator sidecar, only if you opted into that backend. |
| `daemon-admin.token` | Per-process admin-route token (owner-only file permissions, rotated each daemon start). |
| `tier-occupancy.json` | What the fetch router learned per domain — which tier works, and backoff state. Inspect it with [`wigolo tune`](./cli.md#tune). |
| `backups/` | A copy of each agent's MCP config file taken just before wigolo rewrites it (agent wiring, or a `config --set` that propagates). Pruned to the 5 most recent per agent. |

`rm -rf ~/.wigolo` erases all of it. `wigolo config --storage` shows what's using space.

## Network egress

wigolo makes outbound connections only to:

1. The **search engines and websites your queries target** — that's the product working.
2. The **LLM provider you configure**, if you configure one. Keyless local setups (including `WIGOLO_LOCAL_LLM=auto` against a local model server) never leave the machine for synthesis.
3. The **account service**, for sign-in, activation checks and telemetry batches. It is one configurable base URL (`WIGOLO_ACCOUNTS_URL`) and nothing derived from a page can change it.

Component downloads (browser engine, models) fetch from their public distribution sources during `init`/`warmup` or first use. There is no license check and no update phone-home.

Activation checks are answered offline from a signed token held on disk, so ordinary tool
runs do not call the service. The sign-in code you type during `register` or `login` goes
to the account service and nowhere else — it never enters a transcript, the cache, or a
telemetry event.

## Usage and reliability telemetry

**On by default as of 0.3.0, and this is a change.** Earlier releases wrote events to a
local file only if you opted in, and transmitted nothing. That is no longer true: an
activated install sends batches of counters to the account service unless you turn the
switch off.

The canonical, always-current statement of what is collected is served by the account
service and shown to you during `register`, before an account exists. It is the version of
record — this page describes the same thing for reading offline, and the version you were
shown is printed by `wigolo account`.

### What is collected

Six event types, and nothing else. Every field of every one is a fixed choice from a fixed
list, a true/false, or a registrable domain (`example.com`, never a path or a query):

| Event | Fields |
| --- | --- |
| a tool ran | which of the ten tools · which surface (agent, REST, terminal, shell) · succeeded or not · how long, as one of six coarse buckets |
| a tool failed | which tool · which surface · the error **class** |
| a fetch was blocked | the registrable domain · why (a challenge, a refusal, or the last tier being reached) |
| a fetch escalated a tier | which tier it escalated to |
| a search engine failed | which engine · the error **class** |
| a daemon reported uptime | one of five duration buckets |

An error **class** is one of `timeout`, `network`, `dns`, `http_4xx`, `http_5xx`,
`blocked`, `invalid_input`, `internal`. No message accompanies it — not a truncated one,
not a sanitized one. A sanitizer is a rule that can be wrong about a string it has never
seen; a fixed list of eight cannot be.

Each batch also carries the wigolo version, your operating system and CPU architecture, and
a timestamp per event, and is authorised as your account — so these counters are attributed
to you rather than anonymous.

### Never

Not "not sent" — **not representable**. There is no free-text field anywhere in the event
dictionary, so no code path, plugin or hand-edited queue file can put any of these on the
wire; a queue line that somehow contained one is rejected rather than trimmed:

- Page content or extracted markdown
- Your queries, prompts or research questions
- Full URLs — only the registrable domain of a *blocked* fetch, never of a successful one
- Credentials, tokens, or API keys
- File paths
- Anything an LLM returned

### Turning it off

```bash
WIGOLO_TELEMETRY=off wigolo search "…"     # one run
wigolo config --set WIGOLO_TELEMETRY=off   # permanently
```

`off`, `no`, `false` and `0` all mean off. Off means nothing is queued, nothing is written
to `telemetry/`, and nothing leaves the machine — the switch is read before an event is
built, not before a batch is sent. Nothing is queued or sent on an install that has never
registered either, because there is no account to attribute counters to.

`wigolo doctor` and `wigolo account` both report which state you are in. Full switch
semantics: [configuration](./configuration.md#account-and-telemetry).

### Your data

`wigolo account export <file>` writes out everything the service holds for your account.
`wigolo account delete` deletes it, after you type `DELETE` to confirm.

## Credentials

Secrets never sit in plaintext on disk:

- **LLM API keys** go to the OS keychain. Where no keychain is available, they're written as AES-256-GCM-encrypted files under `~/.wigolo/keys/`. `init` reads a key only from the `WIGOLO_LLM_API_KEY` env var — never from a flag, so it can't leak into shell history or process listings.
- **The account refresh token** — the only account credential stored at all — goes to the OS keychain, or to an AES-256-GCM-encrypted `~/.wigolo/keys/account.enc` where no keychain is available. The short-lived access token is held in memory only and never written down. Neither ever appears in logs, command output, or `config.json`.
- **Proxy credentials** (and the URLs for opt-in solver/reader services): userinfo is split off and stored in the keychain; only the credential-free URL is persisted to `config.json`.
- **`wigolo config --export`** excludes secrets, so a shared settings file can't leak keys.
- The **REST bearer token** supports `WIGOLO_API_TOKEN_FILE` so deployments can mount it as a secret instead of an env var visible in process inspection.

## Serve-mode hardening

The HTTP daemon assumes the network is hostile:

- **Fail-closed bind gate** — a non-loopback bind with no token refuses to start; open remote access requires a named override flag. ([Details](./rest-api.md#auth-model--fail-closed).)
- **Bearer auth** on the REST + MCP surface when a token is configured; `/health` alone stays open for probes.
- **DNS-rebinding guard** — requests whose `Host` header isn't loopback (or the configured bind host) are rejected, so a malicious page resolving its domain to `127.0.0.1` gets a 403, not your daemon.
- **Browser-origin guard** — any request carrying an `Origin` header is rejected on the MCP and admin routes before token checking, so web pages can't probe token validity.
- **Loopback source is never trusted as auth** — tunnels deliver remote traffic from 127.0.0.1, so authentication is the token, not the source address.
- **Slow-client timeouts, body caps, concurrency caps** bound resource use ([limits](./rest-api.md#resource-limits)).

## SSRF guards

URL-taking surfaces refuse targets that resolve to private or loopback address space:

- `fetch` / `crawl` / every URL-bearing REST route — private targets blocked unless you opt in for local dev (`WIGOLO_FETCH_ALLOW_PRIVATE=true`).
- `watch` **webhook destinations** — a watch notification can't be pointed at your internal network.
- Remote-exposed daemons additionally refuse loopback-literal targets outright, so a remote caller can't use wigolo to probe services on its own host ([posture](./self-hosting.md#network-posture)).

## Responsible disclosure

Please don't open public issues for vulnerabilities. Report privately via GitHub's "Report a vulnerability" on the repository's Security tab — the process, scope, and response expectations are in [SECURITY.md](../SECURITY.md).

[← Docs index](./README.md) · [Back to start: Getting started](./getting-started.md)
