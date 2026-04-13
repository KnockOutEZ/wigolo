# SearXNG MCP Reliability — Design

**Date:** 2026-04-13
**Issues addressed:** [#1](https://github.com/KnockOutEZ/wigolo/issues/1) (bootstrap never retries), [#2](https://github.com/KnockOutEZ/wigolo/issues/2) (Bing tracker URLs)
**Scope:** End-to-end SearXNG reliability for users running wigolo via `npx`.

---

## Problem

Users who hit a transient bootstrap failure end up permanently in degraded fallback mode with no obvious recovery path. Three failure modes compound:

1. **Bootstrap failure becomes permanent.** `bootstrapNativeSearxng` in `src/searxng/bootstrap.ts` writes `state.json` with `status: "failed"` on any error (typically a transient `pip install` network blip). On every subsequent server start, `resolveSearchBackend` (`bootstrap.ts:114-120`) sees the failed status and silently downgrades to direct scrapers. No retry. The only recovery is `rm -rf ~/.wigolo/state.json`, which is undocumented.
2. **Fallback mode itself is broken.** When SearXNG is down, the direct Bing engine returns `bing.com/ck/a?...&u=a1...` tracker URLs instead of destination URLs. An agent that pipes a search result into `fetch` retrieves Bing's redirect page rather than the article.
3. **Failures are invisible.** Errors live in stderr, which most MCP clients hide. Users see "search works but the results are weird" with no signal that SearXNG is down or how to fix it.

The combination is "wigolo silently degrades to its worst mode and stays there." The setup needs to stay seamless (`npx @staticn0va/wigolo` just works), but failure recovery cannot require manual filesystem surgery.

## Goals

- **Self-heal** transient bootstrap failures across server restarts without user action.
- **Cap auto-recovery** so a fundamentally broken environment doesn't burn 30+ seconds on every startup.
- **Surface failures** to the user in MCP tool responses, not just stderr.
- **Provide an escape hatch** (`warmup --force`, `doctor`) for users who need to intervene.
- **Fix Bing fallback** so degraded mode is at least usable while users wait for auto-recovery.

## Non-Goals

- Changing the embedded-SearXNG architecture (Python venv from GitHub tarball, native+Docker modes).
- Out-of-band telemetry, event log files, or external observability.
- Rebootstrapping automatically when the SearXNG process crashes (Approach C from brainstorming — rejected as a footgun).
- Issues #3 (SPA-shell heuristic) and #4 (extract metadata subset) — these are unrelated root causes; separate specs.

## Approach

Approach B from brainstorming: bounded auto-heal with backoff, captured diagnostics, and a clear escape hatch.

The fix has four layers:

| Layer | What | Where |
|---|---|---|
| State machine | `state.json` becomes a real retry-aware state with attempts, backoff, captured stderr | `src/searxng/bootstrap.ts` |
| Search-side | Decode Bing tracker URLs; surface fallback warning in MCP responses | `src/search/engines/bing.ts`, `src/server.ts`, `src/tools/search.ts`, `src/types.ts` |
| Operator surface | `warmup --force`, new `doctor` command | `src/cli/warmup.ts`, `src/cli/doctor.ts`, `src/cli/index.ts` |
| Process health | Process callbacks + periodic `/healthz` probe → splice from engine list when unhealthy | `src/searxng/process.ts`, `src/server.ts` |

---

## 1. State Machine

### Schema (`BootstrapState`)

```ts
interface BootstrapState {
  status: 'downloading' | 'ready' | 'failed' | 'no_runtime';
  searxngPath?: string;
  attempts?: number;            // total bootstrap attempts (1+)
  lastAttemptAt?: string;       // ISO timestamp
  nextRetryAt?: string;         // ISO timestamp; only meaningful when status=failed
  lastError?: {
    message: string;            // short description, e.g. "pip install failed: 1"
    stderr: string;             // captured pip stderr (full, not truncated)
    exitCode: number | null;
    command: string;            // e.g. "/path/venv/bin/pip install -r requirements.txt"
    timestamp: string;
  };
  error?: string;               // legacy field; read for back-compat, NEVER written by new code
}
```

`setBootstrapState` always writes the new shape (`lastError`, never `error`). The legacy `error` field exists only as a read fallback for state files written by the previous version. After one successful state write post-upgrade, the legacy field is gone.

### Backoff schedule

| Attempt N fails | `nextRetryAt = now + ...` |
|---|---|
| 1 | 30 seconds |
| 2 | 1 hour |
| 3 | 24 hours (last auto-retry) |
| 4+ | not scheduled — `status: failed` stays until `warmup --force` |

`MAX_AUTO_ATTEMPTS = 3`. Both the cap and the schedule are tunable via env (`WIGOLO_BOOTSTRAP_MAX_ATTEMPTS`, `WIGOLO_BOOTSTRAP_BACKOFF_SECONDS=30,3600,86400`).

The 30s first-retry is intentionally short: wigolo is a dev tool, and a developer hitting a transient pip blip and restarting their editor 30 seconds later should NOT have to wait 5 minutes. If 30s isn't enough breathing room (genuinely flaky network), the second attempt's 1-hour wait absorbs that. The 24h third-retry covers extended outages without burning startup time on broken environments.

### Lifecycle

```
   null (no install yet)
        |
        v
   downloading  --(success)-->  ready  (terminal happy state)
        |
     (failure)
        |
        v
   failed { attempts: 1, nextRetryAt: now+30s, lastError: {...} }
        |
   +----+---------+
   | now >= nextRetryAt  AND  attempts < MAX:
   |   resolveSearchBackend returns 'native' on next call
   |   server.ts background bootstrap retries
   |
   +--> success: status -> ready
   +--> failure: status stays failed, attempts++, nextRetryAt extended

   When attempts >= MAX:
        no auto-retry. resolveSearchBackend returns 'docker' (if available) or 'scraping'.
        warmup --force resets the state and starts fresh.
```

### Back-compat

Old state files (only `status` + `error`) are read by treating missing fields as defaults:
- `attempts ?? 1`
- `nextRetryAt ?? new Date(0).toISOString()` → `now >= nextRetryAt` is always true → retry on next start
- `lastError ?? { message: state.error, stderr: '', exitCode: null, command: '', timestamp: '' }`

No migration script is needed. The first `setBootstrapState` call after the upgrade writes the new shape.

### `resolveSearchBackend` retry logic

Replaces `src/searxng/bootstrap.ts:114-120`:

```ts
if (state?.status === 'failed') {
  const attempts = state.attempts ?? 1;
  const nextRetryAt = state.nextRetryAt ? new Date(state.nextRetryAt) : new Date(0);
  const retryWindowOpen = new Date() >= nextRetryAt;
  const budgetRemaining = attempts < MAX_AUTO_ATTEMPTS;

  if (retryWindowOpen && budgetRemaining && checkPythonAvailable()) {
    log.info('SearXNG bootstrap retry window reached', { attempts, nextRetryAt });
    return { type: 'native', searxngPath: join(dataDir, 'searxng') };
  }

  log.warn('SearXNG bootstrap stuck', {
    attempts,
    nextRetryAt: state.nextRetryAt,
    error: state.lastError?.message ?? state.error,
  });
  if (checkDockerAvailable() && config.searxngMode !== 'native') {
    return { type: 'docker' };
  }
  return { type: 'scraping' };
}
```

The `no_runtime` branch stays as-is — Python/Docker not being installed is a legitimate hard failure that does not warrant retry.

`resolveSearchBackend` is a pure decision function — it does NOT mutate the filesystem. Cleanup of any half-written install lives inside `bootstrapNativeSearxng` and runs only after the bootstrap lock is held (see next section).

### Stderr capture in `bootstrapNativeSearxng`

Switch each `execSync` call in `bootstrapNativeSearxng` to `spawnSync` with `encoding: 'utf-8'`. On non-zero exit, throw a structured error:

```ts
class BootstrapError extends Error {
  constructor(public readonly detail: { stderr: string; exitCode: number | null; command: string }) {
    super(`bootstrap step failed: ${detail.command} (exit ${detail.exitCode})`);
  }
}

function runStep(command: string, args: string[], opts: { timeout: number }): void {
  const result = spawnSync(command, args, { encoding: 'utf-8', timeout: opts.timeout });
  if (result.status !== 0 || result.error) {
    throw new BootstrapError({
      stderr: result.stderr ?? String(result.error ?? ''),
      exitCode: result.status,
      command: `${command} ${args.join(' ')}`,
    });
  }
}
```

The catch block computes backoff and writes structured failure:

```ts
} catch (err) {
  const prev = getBootstrapState(dataDir);
  const attempts = (prev?.attempts ?? 0) + 1;
  const backoffSeconds = backoffSchedule(attempts);
  const nextRetryAt = backoffSeconds === null
    ? undefined
    : new Date(Date.now() + backoffSeconds * 1000).toISOString();

  const lastError = err instanceof BootstrapError
    ? { message: err.message, stderr: err.detail.stderr, exitCode: err.detail.exitCode, command: err.detail.command, timestamp: new Date().toISOString() }
    : { message: String(err), stderr: '', exitCode: null, command: '', timestamp: new Date().toISOString() };

  setBootstrapState(dataDir, {
    status: 'failed',
    attempts,
    lastAttemptAt: new Date().toISOString(),
    nextRetryAt,
    lastError,
  });
  log.error('SearXNG bootstrap failed', { attempts, nextRetryAt, error: lastError.message });
  throw err;
}
```

### Concurrency

Two concurrent MCP servers (e.g., user runs the same MCP from two clients) could both attempt bootstrap. Add `acquireBootstrapLock(dataDir)` (sibling of the existing `searxng.lock`):

- Writes `bootstrap.lock` with `{ pid, startedAt }` before any state mutation.
- Detects stale locks via the existing `isProcessAlive(pid)` helper (`src/searxng/process.ts:49`).
- A second process detecting a live lock calls `waitForBootstrap()` — polls `state.json` every 2s up to a timeout (60s) until status is `ready` or `failed`. No parallel pip install.

Released in a `finally` block whether bootstrap succeeded or threw.

### Cleanup of partial installs (inside `bootstrapNativeSearxng`)

After acquiring the bootstrap lock, before recreating the venv, wipe any partial install from a previous failed attempt:

```ts
export async function bootstrapNativeSearxng(dataDir: string): Promise<void> {
  const releaseBootstrapLock = acquireBootstrapLock(dataDir);
  try {
    const searxngDir = join(dataDir, 'searxng');
    // Safe: bootstrap lock is held; no other wigolo process can be touching this directory.
    // SearxngProcess holds searxng.lock separately for a running instance — stop() must
    // run before bootstrap is retried (server.ts already does this when state is failed).
    if (existsSync(searxngDir)) {
      log.info('removing previous SearXNG install before retry');
      rmSync(searxngDir, { recursive: true, force: true });
    }

    setBootstrapState(dataDir, { status: 'downloading', attempts: ((getBootstrapState(dataDir)?.attempts) ?? 0) + 0 });
    // ... existing install logic using runStep() ...
  } catch (err) {
    // ... write failed state with backoff (see "Stderr capture" section) ...
    throw err;
  } finally {
    releaseBootstrapLock();
  }
}
```

The cleanup is local to `bootstrapNativeSearxng`. `resolveSearchBackend` callers cannot accidentally race with another process's in-progress bootstrap because the lock acquisition happens first.

---

## 2. Search-Side Fixes

### Bing URL decoder (issue #2)

In `src/search/engines/bing.ts`:

```ts
function decodeBingTrackerUrl(href: string): string {
  let u: URL;
  try { u = new URL(href); } catch { return href; }
  if (!u.hostname.endsWith('bing.com') || u.pathname !== '/ck/a') return href;

  const encoded = u.searchParams.get('u');
  if (!encoded || encoded.length < 4) return href;

  // Bing format: 2-char prefix (commonly "a1") + URL-safe base64 of the destination
  const trimmed = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
  const padded = trimmed + '='.repeat((4 - trimmed.length % 4) % 4);
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    new URL(decoded); // sanity check
    return decoded;
  } catch {
    return href;
  }
}
```

Applied at the result-mapping step in `BingEngine.search()`, before validation. Decoded URLs that still aren't valid destinations fall through to the existing `validateLinks` step.

We do **not** decode in `searxng.ts` — SearXNG's Bing engine already decodes server-side. Only our direct scraper hits the `/ck/a` redirector.

### MCP response warning (one-shot per fallback session)

`BackendStatus` is a class (not a plain object) so the one-shot semantic is encapsulated and can't be subverted by accidental field mutation in callers. Lives in a new file `src/server/backend-status.ts`:

```ts
export class BackendStatus {
  private _active = false;
  private _reason: string | undefined;
  private _warned = false;

  get isActive(): boolean { return this._active; }

  markUnhealthy(reason: string): void {
    this._active = false;
    this._reason = reason;
    this._warned = false;          // next response surfaces the warning
  }

  markHealthy(): void {
    this._active = true;
    this._reason = undefined;
    this._warned = false;          // reset so a future fallback warns fresh
  }

  /** Returns warning text once per fallback session, then undefined. */
  consumeWarning(): string | undefined {
    if (this._active || this._warned) return undefined;
    this._warned = true;
    return (
      `SearXNG embedded search is unavailable; using direct engine scraping (lower quality). ` +
      `Reason: ${this._reason ?? 'unknown'}. ` +
      `To retry: \`npx @staticn0va/wigolo warmup --force\`. ` +
      `For details: \`npx @staticn0va/wigolo doctor\`.`
    );
  }
}
```

Owned by `server.ts`, passed as a constructor-style argument into `handleSearch`. Transitions:

| Event | Method |
|---|---|
| Bootstrap completes, SearXNG starts | `markHealthy()` |
| Bootstrap stays failed at startup | `markUnhealthy("bootstrap stuck after N attempts: <message>")` |
| Process crashes past restart limit | `markUnhealthy("SearXNG process crashed N times in 60s")` |
| `/healthz` probe fails 3 times | `markUnhealthy("SearXNG /healthz unreachable")` |
| Process recovers (probe or external restart) | `markHealthy()` |

In `handleSearch`, after building the response:

```ts
const warning = status.consumeWarning();
if (warning) output.warning = warning;
```

The class API hides `_warned` from handlers — they cannot accidentally re-surface or suppress the warning.

### MCP-level surfacing

The MCP tool result includes the warning in TWO places, belt-and-suspenders, so any client with any rendering strategy sees it:

1. **A separate `text` content block prepended to the result**, so MCP clients that show only the first content block still see the notice prominently:
   ```ts
   const blocks: { type: 'text'; text: string }[] = [];
   if (result.warning) {
     blocks.push({ type: 'text', text: `[wigolo notice] ${result.warning}` });
   }
   blocks.push({ type: 'text', text: JSON.stringify(result, null, 2) });
   return { content: blocks, isError: !!result.error };
   ```
2. **Top-level `warning` field on `SearchOutput`**, so agents that parse the JSON see it as part of the search result schema. Add `warning?: string` to `SearchOutput` in `src/types.ts`.

The MCP spec allows multiple content blocks in a tool result; this is well-supported by all known MCP clients (Claude Code, Cursor, Gemini CLI tested). If the notice text block were the only surface, programmatic agents that JSON.parse the result would lose it. If the JSON field were the only surface, naive clients that show only the first content block would lose it. Both surfaces cost ~1 line each.

**Why one-shot, not every response:** Matches the "agent surfaces it once → user takes action or ignores" mental model. Persistent warnings would noise up every search response and likely get filtered out by agent prompts.

---

## 3. CLI Surface

### `warmup --force`

Extends `runWarmup` in `src/cli/warmup.ts`. When `--force` is in the flag set, before normal flow:

```ts
function wipeSearxngState(dataDir: string): void {
  rmSync(join(dataDir, 'state.json'), { force: true });
  rmSync(join(dataDir, 'searxng'), { recursive: true, force: true });
  rmSync(join(dataDir, 'bootstrap.lock'), { force: true });
  rmSync(join(dataDir, 'searxng.lock'), { force: true });
  rmSync(join(dataDir, 'searxng.port'), { force: true });
  log('Wiped SearXNG state, install, and locks (--force)');
}
```

Then runs the existing `setupSearxng` → `bootstrapNativeSearxng` path. State starts fresh, so `attempts` resets to 1 and the user is back to a clean retry budget.

The lock files are wiped because a stale `bootstrap.lock` (process died mid-bootstrap with the lock held) would otherwise block the new bootstrap until the stale-PID detection ran. `--force` is the user's "I want this fixed now" signal — don't make them wait. The `searxng.lock` and `searxng.port` are also wiped in case a previous server instance died ungracefully.

`--force` only affects SearXNG. Playwright/Trafilatura/FlashRank steps are not re-run unless their respective flags are also set.

### `doctor` (new command)

Atomic change in `src/cli/index.ts`: extend the `Command` type union to include `'doctor'` AND add `'doctor'` to `KNOWN_COMMANDS`. Both must change together — the type guard depends on the union. New file `src/cli/doctor.ts` and a switch case in `src/index.ts`.

`doctor` is the single command that answers "what does my wigolo setup look like right now?" It checks every component, not just SearXNG.

Diagnostic dump to stderr:

```
[wigolo doctor] Data dir:        /Users/foo/.wigolo

[wigolo doctor] Runtime:
  Python 3:      available (3.12.4)
  Docker:        not available

[wigolo doctor] Playwright:
  Installation:  installed (v1.45.2)
  Browsers:      chromium ✓  firefox ✗  webkit ✗

[wigolo doctor] Optional Python packages:
  Trafilatura:   installed (v1.12.0)
  FlashRank:     not installed

[wigolo doctor] SearXNG install:
  status:        failed
  attempts:      2 / 3
  lastAttemptAt: 2026-04-13T09:15:01Z
  nextRetryAt:   2026-04-13T10:15:01Z (in 47 minutes)
  command:       /Users/foo/.wigolo/searxng/venv/bin/pip install -r requirements.txt
  exit code:     1
  message:       pip install failed: 1
  stderr:
    ERROR: Could not find a version that satisfies the requirement msgspec>=0.18.4
    ...

[wigolo doctor] SearXNG process:  not running

[wigolo doctor] Recovery:
  - Wait until next auto-retry (47 minutes), or
  - Force retry now: npx @staticn0va/wigolo warmup --force

[wigolo doctor] Overall: DEGRADED (SearXNG not running)
```

If state is `ready` and the process is up, the SearXNG section prints OK + path + port. If no state file exists, prints "not bootstrapped — run `npx @staticn0va/wigolo warmup`".

**Detection strategy for each component:**
- Python: `spawnSync('python3', ['--version'])` → parse version string.
- Docker: `spawnSync('docker', ['--version'])` → boolean check.
- Playwright installation: `require.resolve('playwright')` + `require('playwright/package.json').version`.
- Playwright browsers: check `~/Library/Caches/ms-playwright/` (macOS) / equivalent paths per platform; safer fallback is `spawnSync('npx', ['playwright', '--version'])`.
- Trafilatura: `spawnSync('python3', ['-c', 'import trafilatura; print(trafilatura.__version__)'])`.
- FlashRank: same pattern as Trafilatura.
- SearXNG state: read `state.json` directly.
- SearXNG process: read `searxng.lock` → `isProcessAlive(pid)` + `fetch(/healthz)` if alive.

**Exit code (Question 1 answered):** `doctor` exits **0** when all components are OK or only optional ones (Trafilatura/FlashRank not installed) are missing. Exits **1** when ANY required component is degraded — bootstrap state is `failed` or `no_runtime`, the SearXNG process is supposed to be up but isn't, Playwright browsers are missing, or Python is missing. This lets users script health checks: `npx @staticn0va/wigolo doctor && start-my-agent`.

The existing `health` stub command stays as-is (scoped to v2 daemon mode).

---

## 4. Process Health

### Callbacks

Extend `SearxngProcess` constructor to accept callbacks:

```ts
interface ProcessCallbacks {
  onUnhealthy?: (reason: string) => void;
  onHealthy?: () => void;
}

class SearxngProcess {
  constructor(
    private readonly searxngPath: string,
    private readonly dataDir: string,
    private readonly callbacks: ProcessCallbacks = {},
  ) {}
}
```

### Crash-limit handler (`monitorCrashes`)

The existing crash-restart logic (`process.ts:178-201`) restarts up to `MAX_CRASH_RESTARTS` (3) within `CRASH_WINDOW_MS` (60s). When the limit is hit (currently just logs), additionally flip `isCurrentlyUnhealthy` and fire `onUnhealthy(...)`:

```ts
if (this.crashTimes.length >= MAX_CRASH_RESTARTS) {
  log.error('too many crashes, giving up on SearXNG', { crashes: this.crashTimes.length });
  releaseLock(this.dataDir);
  if (!this.isCurrentlyUnhealthy) {
    this.isCurrentlyUnhealthy = true;
    this.callbacks.onUnhealthy?.(
      `SearXNG process crashed ${this.crashTimes.length} times in ${CRASH_WINDOW_MS / 1000}s`,
    );
  }
  return;
}
```

If the user later re-runs `warmup --force` or manually starts a SearXNG instance on the same port, the next probe tick observes `/healthz` healthy AND `isCurrentlyUnhealthy === true` → fires `onHealthy()`. Recovery works regardless of which path triggered the unhealthy state.

### Periodic `/healthz` probe

A new method in `SearxngProcess` started after the initial health check passes. Interval is configurable via `WIGOLO_HEALTH_PROBE_INTERVAL_MS` (default 30000).

```ts
private healthProbeFailures = 0;
private healthProbeTimer?: NodeJS.Timeout;
private isCurrentlyUnhealthy = false;   // single source of truth for callback firing

private startHealthProbe(): void {
  const intervalMs = getConfig().healthProbeIntervalMs;  // env: WIGOLO_HEALTH_PROBE_INTERVAL_MS
  this.healthProbeTimer = setInterval(async () => {
    if (this.stopped || !this.port) return;
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        this.healthProbeFailures = 0;
        if (this.isCurrentlyUnhealthy) {
          this.isCurrentlyUnhealthy = false;
          this.callbacks.onHealthy?.();
        }
      } else {
        this.notePotentialFailure();
      }
    } catch {
      this.notePotentialFailure();
    }
  }, intervalMs);
}

private notePotentialFailure(): void {
  this.healthProbeFailures++;
  if (this.healthProbeFailures === 3 && !this.isCurrentlyUnhealthy) {
    this.isCurrentlyUnhealthy = true;
    this.callbacks.onUnhealthy?.('SearXNG /healthz unreachable for 3 consecutive probes');
  }
}
```

The `isCurrentlyUnhealthy` flag is the single source of truth for whether `onUnhealthy` has fired since the last healthy state. The crash-limit handler (below) also flips this flag, so a process that was killed by crash-limit and then manually restarted by the user externally is correctly detected as recovered on the next successful probe — even though `healthProbeFailures` was 0 throughout that path.

Cleared on `stop()`.

### Server wiring

```ts
const backendStatus = new BackendStatus();

searxngProcess = new SearxngProcess(backend.searxngPath, config.dataDir, {
  onUnhealthy: (reason) => {
    backendStatus.markUnhealthy(reason);
    const idx = searchEngines.findIndex(e => e.name === 'searxng');
    if (idx >= 0) searchEngines.splice(idx, 1);
    log.warn('SearXNG marked unhealthy', { reason });
  },
  onHealthy: () => {
    const url = searxngProcess?.getUrl();
    if (!url) return;
    backendStatus.markHealthy();
    if (!searchEngines.some(e => e.name === 'searxng')) {
      searchEngines.unshift(new SearxngClient(url));
    }
    log.info('SearXNG recovered');
  },
});

const url = await searxngProcess.start();
if (url) {
  searchEngines.unshift(new SearxngClient(url));
  backendStatus.markHealthy();
}
```

Same wiring for `DockerSearxng` (out of scope to refactor docker.ts beyond passing the same callbacks; behavior parity for Docker mode is a nice-to-have, not required).

---

## Testing Strategy

### Unit tests

`tests/unit/searxng/bootstrap.test.ts`:
- Retry-window logic: `failed` with `nextRetryAt` past → returns `native`; future → returns `scraping`.
- Backoff schedule: attempts 1/2/3 produce 30s/1h/24h `nextRetryAt`; attempt 4 returns `null` (no further retry).
- Attempt cap: `attempts >= MAX_AUTO_ATTEMPTS` → no retry even if window open.
- Legacy state migration: `{status: 'failed', error: 'x'}` with no `attempts`/`nextRetryAt` → retries immediately on next call.
- `BootstrapError` capture: failed `spawnSync` writes `lastError.stderr` containing the captured stream.
- Concurrency lock: second bootstrap call while first holds the lock waits for completion (no double pip install).

Mocks: `Date.now`, `existsSync`, `readFileSync`, `writeFileSync`, `spawnSync`, `rmSync` via `vi.mock`.

`tests/unit/search/engines/bing-decoder.test.ts`:
- 3+ real captured Bing tracker URLs → decoded destinations match expected.
- Non-Bing URL → unchanged.
- Bing URL without `u` param → unchanged.
- Malformed base64 → unchanged (no throw).
- Decoded value that isn't a valid URL → unchanged.

Fixtures: `tests/fixtures/bing-tracker-urls.json` with hand-captured real URLs (stable over time).

`tests/unit/cli/doctor.test.ts`:
- `failed` state → output includes attempts, human-readable `nextRetryAt`, stderr, recovery commands.
- `ready` state → OK summary.
- No state file → "not bootstrapped" message.

`tests/unit/server/backend-status.test.ts`:
- `BackendStatus` starts inactive; `consumeWarning()` returns text once, then `undefined` on subsequent calls.
- `markHealthy()` followed by `markUnhealthy(reason)` resets the one-shot, so `consumeWarning()` returns text again.
- `consumeWarning()` returns `undefined` when `isActive === true`.
- The warning text includes the reason, the `warmup --force` command, and the `doctor` command.

`tests/unit/cli/doctor.test.ts`:
- Mock filesystem + `spawnSync` to construct each component state. Verify exit code 0 when all OK, exit 1 when SearXNG `failed`, exit 1 when Playwright browsers missing, exit 0 when only Trafilatura/FlashRank missing (optional).
- Output snapshot: failed state includes attempts, human-readable `nextRetryAt`, stderr, recovery commands, and `Overall: DEGRADED` line.

`tests/unit/searxng/process-health.test.ts`:
- Mock `setInterval` and `fetch`. Probe success when previously unhealthy → fires `onHealthy` once and clears `isCurrentlyUnhealthy`.
- Probe failures (3 consecutive) → fires `onUnhealthy` once with the right reason, sets `isCurrentlyUnhealthy`.
- After crash-limit fires `onUnhealthy`, the next successful probe still fires `onHealthy` (recovery from external restart path).
- `isCurrentlyUnhealthy` prevents double-firing of either callback.

### Integration tests

`tests/integration/searxng-retry.test.ts`:
- Temp `dataDir`, write `failed` state with past `nextRetryAt`. Monkey-patch `bootstrapNativeSearxng` to succeed → `resolveSearchBackend` returns `native`, background bootstrap completes, state becomes `ready`.
- Same setup, bootstrap throws → state stays `failed`, attempts incremented, `nextRetryAt` extended per backoff schedule.

`tests/integration/warmup-force.test.ts`:
- Pre-seed `failed` state with `attempts=3`. Run `runWarmup(['--force'])` → `state.json` and `searxng/` both wiped before bootstrap call. After `bootstrapNativeSearxng` succeeds (mocked), state is `ready` with `attempts: 1`.

### E2E (gated by `WIGOLO_E2E=1`)

`tests/e2e/searxng-cold-bootstrap.e2e.test.ts`:
- Empty `~/.wigolo/`-equivalent, MCP server starts, search() works on direct scrapers immediately. Background bootstrap eventually completes — the test polls `state.json` for `status === 'ready'` rather than waiting a fixed duration:
  ```ts
  await waitFor(
    () => getBootstrapState(dataDir)?.status === 'ready',
    { timeoutMs: 120_000, intervalMs: 1000 },
  );
  ```
  After the poll resolves, a subsequent search() call confirms SearXNG is in the engine list. Slow + network-dependent — gated. The 120s timeout is generous enough for slow PyPI/network conditions; CI failures here indicate either a real bug or a network outage that should be retried, not a flake.

A small `waitFor(predicate, opts)` helper lives in `tests/helpers/wait-for.ts` (new file) — used by this test and reusable for future E2Es.

### Manual verification checklist

- Cold install on machine with no `~/.wigolo/` → first run works (direct scrapers), second run uses SearXNG.
- Simulated bootstrap failure (block PyPI via `/etc/hosts` or HTTP proxy) → `state.json` shows `failed` with stderr captured, `wigolo doctor` shows it clearly, `warmup --force` resets cleanly.
- Kill the SearXNG python process while server is running → after crash limit, search responses include the warning, engine list excludes SearXNG client. Restart SearXNG manually → next probe fires `onHealthy`, warning resets.
- Bing decoder against live results: when SearXNG is down, search() returns destination URLs not `bing.com/ck/a` URLs.

---

## Files Touched

**New:**
- `src/cli/doctor.ts`
- `src/server/backend-status.ts`
- `tests/helpers/wait-for.ts`
- `tests/unit/searxng/bootstrap.test.ts`
- `tests/unit/searxng/process-health.test.ts`
- `tests/unit/search/engines/bing-decoder.test.ts`
- `tests/unit/cli/doctor.test.ts`
- `tests/unit/server/backend-status.test.ts`
- `tests/integration/searxng-retry.test.ts`
- `tests/integration/warmup-force.test.ts`
- `tests/e2e/searxng-cold-bootstrap.e2e.test.ts`
- `tests/fixtures/bing-tracker-urls.json`

**Modified:**
- `src/searxng/bootstrap.ts` — new state schema, retry logic, stderr capture, bootstrap lock, cleanup of partial install
- `src/searxng/process.ts` — callbacks, periodic `/healthz` probe, `isCurrentlyUnhealthy` flag
- `src/search/engines/bing.ts` — `decodeBingTrackerUrl`
- `src/server.ts` — instantiate `BackendStatus`, wire process callbacks, manage engine list, pass status to handlers, prepend warning content block in tool result
- `src/tools/search.ts` — accept `BackendStatus`, call `consumeWarning()` and inject `warning` field
- `src/types.ts` — add `warning?: string` to `SearchOutput`
- `src/config.ts` — add `bootstrapMaxAttempts`, `bootstrapBackoffSeconds: number[]`, `healthProbeIntervalMs`
- `src/cli/index.ts` — extend `Command` union and `KNOWN_COMMANDS` (atomic) for `doctor`
- `src/cli/warmup.ts` — `--force` flag (wipes state.json, searxng/, bootstrap.lock, searxng.lock, searxng.port)
- `src/index.ts` — switch case for `doctor` (calls `process.exit(code)` based on doctor return)
- `README.md` — document `warmup --force`, `doctor`, auto-recovery behavior, and the three new env vars

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Concurrent MCP servers race on bootstrap | `bootstrap.lock` file with stale-pid detection (mirrors existing `searxng.lock` pattern); `resolveSearchBackend` does no filesystem mutation, all cleanup is inside the lock-protected bootstrap function |
| Stale `nextRetryAt` after system clock change | Backoff is wall-clock based; clock skew at most causes one premature/delayed retry — acceptable |
| Bing decoder breaks on a Bing URL format change | Decoder returns original on any failure; `validateLinks` drops non-resolving URLs; existing fallback behavior preserved |
| Periodic `/healthz` probes add load | Default 30s interval, 2s timeout, only when SearXNG is supposed to be running. Configurable via `WIGOLO_HEALTH_PROBE_INTERVAL_MS`. Negligible at default. |
| `warmup --force` deletes user's working SearXNG install | Acceptable — the flag name signals intent; install is reproducible. Optional confirmation prompt skipped (warmup is non-interactive by design). |
| `warmup --force` deletes a `bootstrap.lock` held by a live process | Live process detection: if `bootstrap.lock` exists AND `isProcessAlive(pid)`, `--force` aborts with an explicit error suggesting the user `kill <pid>` first. Stale locks are wiped silently. |
| 30s first-retry kicks in mid-development too aggressively | The first retry only fires on the *next* server start AFTER the failed bootstrap; it doesn't restart in-process. A developer's editor keeps the same MCP process alive between queries. |
| `doctor` exposes raw stderr that may contain paths | Already in user's own home dir; nothing sensitive. No redaction needed. |
| `doctor` exit code 1 in scripts breaks user workflows that previously didn't check | New command — no existing scripts to break. README documents the contract. |

## Configuration

New env vars added in `src/config.ts`:

| Variable | Default | Purpose |
|---|---|---|
| `WIGOLO_BOOTSTRAP_MAX_ATTEMPTS` | `3` | Cap on auto-retry attempts before bootstrap stays `failed` until `warmup --force` |
| `WIGOLO_BOOTSTRAP_BACKOFF_SECONDS` | `30,3600,86400` | Comma-separated backoff seconds for attempts 1, 2, 3. Length should equal `MAX_ATTEMPTS`. |
| `WIGOLO_HEALTH_PROBE_INTERVAL_MS` | `30000` | Interval between `/healthz` probes against the running SearXNG process. |

All three documented in `README.md` env var table.

## Decisions Recorded

These were open questions resolved during spec review:

1. **`doctor` exit code:** 0 when all components healthy or only optional packages missing; 1 when any required component (Python, Playwright browsers, SearXNG bootstrap, SearXNG process when expected) is degraded. Scripts can use `npx wigolo doctor && ...`.
2. **`warmup --force` lock cleanup:** Yes — `--force` wipes `bootstrap.lock`, `searxng.lock`, and `searxng.port` in addition to `state.json` and the install dir. Aborts with an error if `bootstrap.lock` belongs to a *live* PID.
3. **MCP warning surfacing:** Belt-and-suspenders. Warning appears as both a separate prepended `text` content block (visible to clients that show the first block only) AND a top-level `warning` field on `SearchOutput` (visible to agents that JSON.parse the result).

## Out of Scope

- Issues #3, #4 (separate root causes; separate specs)
- Daemon mode (`serve`, `health`) — those stubs stay v2-pending
- Telemetry, structured event log file, Prometheus metrics
- Auto-rebootstrap on process crash (rejected as a footgun)
- Docker mode parity for callbacks (nice-to-have, not required for issue resolution)
