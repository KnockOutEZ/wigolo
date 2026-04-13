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
| 1 | 5 minutes |
| 2 | 1 hour |
| 3 | 24 hours (last auto-retry) |
| 4+ | not scheduled — `status: failed` stays until `warmup --force` |

`MAX_AUTO_ATTEMPTS = 3`. Both the cap and the schedule are tunable via env (`WIGOLO_BOOTSTRAP_MAX_ATTEMPTS`, `WIGOLO_BOOTSTRAP_BACKOFF_SECONDS=300,3600,86400`).

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
   failed { attempts: 1, nextRetryAt: now+5min, lastError: {...} }
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
    // Safe: the bootstrap lock guards this directory, and the SearxngProcess
    // lock guards a running install. A stuck `failed` state means no live
    // process holds either lock. If a stale lock points at a live PID, the
    // bootstrap lock acquisition below will block before we touch the dir.
    rmSync(join(dataDir, 'searxng'), { recursive: true, force: true });
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

A new `BackendStatus` ref shared between `server.ts` and `handleSearch`:

```ts
interface BackendStatus {
  searxngActive: boolean;        // is SearXNG currently in the engine list?
  fallbackReason?: string;       // human-readable reason
  warningSurfaced: boolean;      // has this fallback been mentioned in a tool response yet?
}
```

Owned by `server.ts`, passed by reference into `handleSearch` via the existing tool-handler closure. Transitions:

| Event | Effect |
|---|---|
| Bootstrap completes, SearXNG starts | `searxngActive=true, warningSurfaced=false, fallbackReason=undefined` |
| Bootstrap stays failed at startup | `searxngActive=false, warningSurfaced=false, fallbackReason="bootstrap stuck after N attempts: <message>"` |
| Process crashes past restart limit | `searxngActive=false, warningSurfaced=false, fallbackReason="SearXNG process crashed N times in 60s"` |
| `/healthz` probe fails 3 times | `searxngActive=false, warningSurfaced=false, fallbackReason="SearXNG /healthz unreachable"` |
| Process recovers / restart succeeds | `searxngActive=true, warningSurfaced=false, fallbackReason=undefined` |

In `handleSearch`, after building the response:

```ts
if (!status.searxngActive && !status.warningSurfaced) {
  output.warning =
    `SearXNG embedded search is unavailable; using direct engine scraping (lower quality). ` +
    `Reason: ${status.fallbackReason ?? 'unknown'}. ` +
    `To retry: \`npx @staticn0va/wigolo warmup --force\`. ` +
    `For details: \`npx @staticn0va/wigolo doctor\`.`;
  status.warningSurfaced = true;
}
```

Add `warning?: string` to `SearchOutput` in `src/types.ts`. The flag resets each time SearXNG goes from active → inactive, so subsequent fallbacks re-surface.

**Why one-shot, not every response:** Matches the "agent surfaces it once → user takes action or ignores" mental model. Persistent warnings would noise up every search response and likely get filtered out by agent prompts.

---

## 3. CLI Surface

### `warmup --force`

Extends `runWarmup` in `src/cli/warmup.ts`. When `--force` is in the flag set, before normal flow:

```ts
function wipeSearxngState(dataDir: string): void {
  rmSync(join(dataDir, 'state.json'), { force: true });
  rmSync(join(dataDir, 'searxng'), { recursive: true, force: true });
  log('Wiped SearXNG state and install (--force)');
}
```

Then runs the existing `setupSearxng` → `bootstrapNativeSearxng` path. State starts fresh, so `attempts` resets to 1 and the user is back to a clean retry budget.

`--force` only affects SearXNG. Playwright/Trafilatura/FlashRank steps are not re-run unless their respective flags are also set.

### `doctor` (new command)

Atomic change in `src/cli/index.ts`: extend the `Command` type union to include `'doctor'` AND add `'doctor'` to `KNOWN_COMMANDS`. Both must change together — the type guard depends on the union. New file `src/cli/doctor.ts` and a switch case in `src/index.ts`.

Single-shot diagnostic dump to stderr:

```
[wigolo doctor] Data dir: /Users/foo/.wigolo
[wigolo doctor] Python 3:    available (3.12.4)
[wigolo doctor] Docker:      not available
[wigolo doctor] Playwright:  installed

[wigolo doctor] SearXNG state:
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

[wigolo doctor] Recovery:
  - Wait until next auto-retry (47 minutes), or
  - Force retry now: npx @staticn0va/wigolo warmup --force
```

If state is `ready`, prints OK summary and the SearXNG path. If no state file exists, prints "not bootstrapped — run `npx @staticn0va/wigolo warmup`".

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

The existing crash-restart logic (`process.ts:178-201`) restarts up to `MAX_CRASH_RESTARTS` (3) within `CRASH_WINDOW_MS` (60s). When the limit is hit (currently just logs), additionally fire `onUnhealthy(...)`:

```ts
if (this.crashTimes.length >= MAX_CRASH_RESTARTS) {
  log.error('too many crashes, giving up on SearXNG', { crashes: this.crashTimes.length });
  releaseLock(this.dataDir);
  this.callbacks.onUnhealthy?.(
    `SearXNG process crashed ${this.crashTimes.length} times in ${CRASH_WINDOW_MS / 1000}s`,
  );
  return;
}
```

### Periodic `/healthz` probe

A new method in `SearxngProcess` started after the initial health check passes:

```ts
private healthProbeFailures = 0;
private healthProbeTimer?: NodeJS.Timeout;

private startHealthProbe(): void {
  this.healthProbeTimer = setInterval(async () => {
    if (this.stopped || !this.port) return;
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        if (this.healthProbeFailures > 0) {
          this.callbacks.onHealthy?.();
        }
        this.healthProbeFailures = 0;
      } else {
        this.notePotentialFailure();
      }
    } catch {
      this.notePotentialFailure();
    }
  }, 30000);
}

private notePotentialFailure(): void {
  this.healthProbeFailures++;
  if (this.healthProbeFailures === 3) {
    this.callbacks.onUnhealthy?.('SearXNG /healthz unreachable for 3 consecutive probes');
  }
}
```

Cleared on `stop()`.

### Server wiring

```ts
const backendStatus: BackendStatus = { searxngActive: false, warningSurfaced: false };

searxngProcess = new SearxngProcess(backend.searxngPath, config.dataDir, {
  onUnhealthy: (reason) => {
    backendStatus.searxngActive = false;
    backendStatus.fallbackReason = reason;
    backendStatus.warningSurfaced = false;
    const idx = searchEngines.findIndex(e => e.name === 'searxng');
    if (idx >= 0) searchEngines.splice(idx, 1);
    log.warn('SearXNG marked unhealthy', { reason });
  },
  onHealthy: () => {
    if (backendStatus.searxngActive) return;
    const url = searxngProcess?.getUrl();
    if (url) {
      backendStatus.searxngActive = true;
      backendStatus.fallbackReason = undefined;
      backendStatus.warningSurfaced = false;
      if (!searchEngines.some(e => e.name === 'searxng')) {
        searchEngines.unshift(new SearxngClient(url));
      }
      log.info('SearXNG recovered');
    }
  },
});

const url = await searxngProcess.start();
if (url) {
  searchEngines.unshift(new SearxngClient(url));
  backendStatus.searxngActive = true;
}
```

Same wiring for `DockerSearxng` (out of scope to refactor docker.ts beyond passing the same callbacks; behavior parity for Docker mode is a nice-to-have, not required).

---

## Testing Strategy

### Unit tests

`tests/unit/searxng/bootstrap.test.ts`:
- Retry-window logic: `failed` with `nextRetryAt` past → returns `native`; future → returns `scraping`.
- Backoff schedule: attempts 1/2/3 produce 5min/1h/24h `nextRetryAt`; attempt 4 returns `null` (no further retry).
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
- `handleSearch` injects `warning` exactly once when `searxngActive=false && warningSurfaced=false`.
- Subsequent calls don't re-inject while `searxngActive` stays false.
- After `onHealthy()` then `onUnhealthy()`, warning re-surfaces once.

### Integration tests

`tests/integration/searxng-retry.test.ts`:
- Temp `dataDir`, write `failed` state with past `nextRetryAt`. Monkey-patch `bootstrapNativeSearxng` to succeed → `resolveSearchBackend` returns `native`, background bootstrap completes, state becomes `ready`.
- Same setup, bootstrap throws → state stays `failed`, attempts incremented, `nextRetryAt` extended per backoff schedule.

`tests/integration/warmup-force.test.ts`:
- Pre-seed `failed` state with `attempts=3`. Run `runWarmup(['--force'])` → `state.json` and `searxng/` both wiped before bootstrap call. After `bootstrapNativeSearxng` succeeds (mocked), state is `ready` with `attempts: 1`.

### E2E (gated by `WIGOLO_E2E=1`)

`tests/e2e/searxng-cold-bootstrap.e2e.test.ts`:
- Empty `~/.wigolo/`-equivalent, MCP server starts, search() works on direct scrapers immediately, background bootstrap completes (~17s), subsequent search() uses SearXNG. Slow + network-dependent — gated.

### Manual verification checklist

- Cold install on machine with no `~/.wigolo/` → first run works (direct scrapers), second run uses SearXNG.
- Simulated bootstrap failure (block PyPI via `/etc/hosts` or HTTP proxy) → `state.json` shows `failed` with stderr captured, `wigolo doctor` shows it clearly, `warmup --force` resets cleanly.
- Kill the SearXNG python process while server is running → after crash limit, search responses include the warning, engine list excludes SearXNG client. Restart SearXNG manually → next probe fires `onHealthy`, warning resets.
- Bing decoder against live results: when SearXNG is down, search() returns destination URLs not `bing.com/ck/a` URLs.

---

## Files Touched

**New:**
- `src/cli/doctor.ts`
- `tests/unit/searxng/bootstrap.test.ts`
- `tests/unit/search/engines/bing-decoder.test.ts`
- `tests/unit/cli/doctor.test.ts`
- `tests/unit/server/backend-status.test.ts`
- `tests/integration/searxng-retry.test.ts`
- `tests/integration/warmup-force.test.ts`
- `tests/e2e/searxng-cold-bootstrap.e2e.test.ts`
- `tests/fixtures/bing-tracker-urls.json`

**Modified:**
- `src/searxng/bootstrap.ts` — new state schema, retry logic, stderr capture, bootstrap lock
- `src/searxng/process.ts` — callbacks, periodic `/healthz` probe
- `src/search/engines/bing.ts` — `decodeBingTrackerUrl`
- `src/server.ts` — `BackendStatus`, wire process callbacks, manage engine list, pass status to handlers
- `src/tools/search.ts` — accept `BackendStatus`, inject `warning` field
- `src/types.ts` — add `warning?: string` to `SearchOutput`
- `src/cli/index.ts` — register `doctor` command
- `src/cli/warmup.ts` — `--force` flag
- `src/index.ts` — switch case for `doctor`
- `README.md` — document `warmup --force` and `doctor`, mention auto-recovery behavior

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Concurrent MCP servers race on bootstrap | `bootstrap.lock` file with stale-pid detection (mirrors existing `searxng.lock` pattern) |
| Stale `nextRetryAt` after system clock change | Backoff is wall-clock based; clock skew at most causes one premature/delayed retry — acceptable |
| Bing decoder breaks on a Bing URL format change | Decoder returns original on any failure; `validateLinks` drops non-resolving URLs; existing fallback behavior preserved |
| Periodic `/healthz` probes add load | 30s interval, 2s timeout, only when SearXNG is supposed to be running. Negligible. |
| `warmup --force` deletes user's working SearXNG install | Acceptable — the flag name signals intent; install is reproducible. Optional confirmation prompt skipped (warmup is non-interactive by design). |
| `doctor` exposes raw stderr that may contain paths | Already in user's own home dir; nothing sensitive. No redaction needed. |

## Out of Scope

- Issues #3, #4 (separate root causes; separate specs)
- Daemon mode (`serve`, `health`) — those stubs stay v2-pending
- Telemetry, structured event log file, Prometheus metrics
- Auto-rebootstrap on process crash (rejected as a footgun)
- Docker mode parity for callbacks (nice-to-have, not required for issue resolution)
