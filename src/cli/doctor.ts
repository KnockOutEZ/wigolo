import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePythonExe } from '../python-env.js';
import { probeBrowser } from '../fetch/browser-probe.js';
import { getBootstrapState, type BootstrapState } from '../searxng/bootstrap.js';
import { isProcessAlive } from '../searxng/process.js';
import { resolveContainerCli } from '../searxng/docker.js';
import { getConfig } from '../config.js';
import { initDatabase, closeDatabase } from '../cache/db.js';
import { getCacheStats } from '../cache/store.js';
import { getBackgroundIndexQueue } from '../embedding/background-queue.js';
import { loadFeedConfig } from '../search/core/rss/feed-config.js';
import {
  getEngineHealthSummary,
  getRegisteredEngineEntries,
  type EngineHealthEntry,
} from '../search/core/engine-health.js';
import type { EngineEntry } from '../search/core/engine-base.js';
import { isTelemetryEnabled } from './telemetry.js';
import { allProviders, providerEnvVar, providerKeyFromEnv, selectProvider } from '../integrations/cloud/llm/select.js';
import { resolveModel, providerDefaultModel, providerModelEnvVar } from '../integrations/cloud/llm/model-select.js';
import { readKey } from '../security/key-store.js';
import { setLogSuppression } from '../logger.js';
import { isLlmConfigured } from '../integrations/cloud/llm/run.js';
import { resolveCustomBackend, pickOllamaModel } from '../integrations/cloud/llm/custom-backend.js';
import { probeOllama, resolveProbeBaseUrl, maybeOllamaHint, DEFAULT_PROBE_TIMEOUT_MS } from './ollama-probe.js';
import { resolveLocalModelTier, type LocalModelTier } from '../integrations/cloud/llm/local-tier.js';
import { installBrowser, installEmbeddings, wipeSearxngState } from './warmup.js';
import { resetBreakers, getBreakerSnapshot } from '../search/core/engine-base.js';
import { searxngConfigured } from '../searxng/enabled.js';
import { readAdminToken } from '../daemon/admin-token.js';
import { getVersion } from './help.js';

function out(line = ''): void { process.stderr.write(`${line}\n`); }

/**
 * Mask an API key for display in doctor output.
 * Shows at most 8 characters (or 25% of the key length) then asterisks.
 * Never returns the full key value.
 */
export function maskApiKey(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '*'.repeat(value.length);
  const show = Math.min(8, Math.ceil(value.length * 0.25));
  return value.slice(0, show) + '*'.repeat(Math.max(4, value.length - show));
}

/**
 * Format provider/key-location/masked-value lines for doctor output.
 * Returns one or more display lines. Key value is ALWAYS masked.
 */
export function formatProviderDoctorLines(
  provider: string,
  location: 'keychain' | 'file' | 'env',
  keyValue: string,
): string[] {
  const masked = maskApiKey(keyValue);
  return [
    `  provider:    ${provider} (key in ${location})`,
    `  key (masked): ${masked}`,
  ];
}

function checkPython(): { ok: boolean; version?: string } {
  const python = resolvePythonExe();
  const r = spawnSync(python, ['--version'], { encoding: 'utf-8' });
  if (r.status !== 0 || r.error) return { ok: false };
  const match = (r.stdout || r.stderr || '').match(/Python (\d+\.\d+\.\d+)/);
  return { ok: true, version: match?.[1] };
}

function checkDocker(): { ok: boolean; version?: string; cli?: string } {
  // Any docker-compatible CLI works — see resolveContainerCli() in
  // searxng/docker.ts (Docker Desktop, plain Docker Engine, or Podman).
  const cli = resolveContainerCli();
  if (!cli) return { ok: false };
  const r = spawnSync(cli, ['--version'], { encoding: 'utf-8' });
  if (r.status !== 0 || r.error) return { ok: false };
  return { ok: true, version: (r.stdout || '').trim(), cli };
}

async function checkPlaywright(): Promise<{ installed: boolean; version?: string; browsers: { chromium: boolean; chromiumHeadlessShell: boolean; firefox: boolean; webkit: boolean }; chromiumPath?: string; chromiumOnDisk: boolean; chromiumError?: string }> {
  let installed = false;
  let version: string | undefined;
  try {
    const r = spawnSync('npx', ['playwright', '--version'], { encoding: 'utf-8', timeout: 5000 });
    if (r.status === 0) {
      installed = true;
      const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
      version = m?.[1];
    }
  } catch { /* ignore */ }

  // Use the SAME shared probe warmup uses so doctor cannot disagree
  // with warmup about browser health. The check is launchability — a real
  // headless launch — not just existsSync, which on bare Linux passes while
  // launch() fails for missing OS libs.
  const [chromiumProbe, firefoxProbe, webkitProbe] = await Promise.all([
    probeBrowser('chromium'),
    probeBrowser('firefox'),
    probeBrowser('webkit'),
  ]);

  // headless-shell uses chromium binary or a sibling; presence implied when
  // chromium ok. If a user explicitly needs the shell, fetch will surface
  // playwright_not_installed regardless.
  return {
    installed,
    version,
    browsers: {
      chromium: chromiumProbe.launchable,
      chromiumHeadlessShell: chromiumProbe.launchable,
      firefox: firefoxProbe.launchable,
      webkit: webkitProbe.launchable,
    },
    chromiumPath: chromiumProbe.execPath || undefined,
    chromiumOnDisk: chromiumProbe.onDisk,
    chromiumError: chromiumProbe.error,
  };
}

// Passive cache-presence probe for the cross-encoder ML reranker. The model
// caches under `dataDir/transformers` — a DIFFERENT directory than the
// fastembed embedding model — so this targets that dir. Loading the model
// downloads it on a fresh dir, so doctor must NOT load it: the download belongs
// to `--fix`/warmup only. lazy ≠ blind — a populated-but-corrupt dir is out of
// scope here (loads surface at first use), presence is the diagnosis signal.
function checkReranker(
  dataDir: string,
): { installed: boolean; reason?: string } {
  const cacheDir = join(dataDir, 'transformers');
  if (!existsSync(cacheDir)) {
    return { installed: false, reason: 'lazy — downloads on first use' };
  }
  try {
    const entries = readdirSync(cacheDir);
    if (entries.length === 0) {
      return { installed: false, reason: 'lazy — downloads on first use' };
    }
    return { installed: true };
  } catch (err) {
    return { installed: false, reason: err instanceof Error ? err.message : 'unknown error' };
  }
}

function checkFastembedCache(dataDir: string): { installed: boolean; reason?: string } {
  const cacheDir = join(dataDir, 'fastembed');
  if (!existsSync(cacheDir)) {
    return { installed: false, reason: 'lazy — downloads on first use' };
  }
  try {
    // First-run downloads create a model subdir with ONNX assets. Empty cache
    // dir means the model has not been fetched yet.
    const entries = readdirSync(cacheDir);
    if (entries.length === 0) {
      return { installed: false, reason: 'lazy — downloads on first use' };
    }
    return { installed: true };
  } catch (err) {
    return { installed: false, reason: err instanceof Error ? err.message : 'unknown error' };
  }
}

/**
 * Cheap data-dir writability probe: create + delete a temp marker file in the
 * data dir. Surfaces the Docker bind-mount EACCES class at diagnosis time
 * rather than deep in a tool call. Returns an actionable reason naming the dir
 * and the fix on failure.
 */
function checkDataDirWritable(dataDir: string): { writable: boolean; reason?: string } {
  const marker = join(dataDir, `.wigolo-doctor-write-probe-${process.pid}`);
  try {
    // Doctor can be the first command on a fresh install — the data dir may not
    // exist yet. Creating it is part of "is this dir usable" and is idempotent.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(marker, 'ok');
    try { unlinkSync(marker); } catch { /* best-effort cleanup */ }
    return { writable: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const detail = `data dir not writable: ${dataDir}${code ? ` (${code})` : ''} — fix directory permissions (Docker: bind-mount as the container uid)`;
    return { writable: false, reason: detail };
  }
}

/**
 * Detect the install channel WITHOUT loading anything heavy. `binary` when
 * running inside a packaged single-executable snapshot (argv[1] / __dirname
 * resolves under a /snapshot path, the @yao-pkg/pkg convention); otherwise the
 * npm-or-source path. Kept deliberately one-line-cheap for support triage.
 */
function detectInstallChannel(): 'binary' | 'npm-or-source' {
  const snapshot = typeof (process as { pkg?: unknown }).pkg !== 'undefined'
    || process.argv[1]?.includes('/snapshot/')
    || fileURLToPath(import.meta.url).includes('/snapshot/');
  return snapshot ? 'binary' : 'npm-or-source';
}

/**
 * Probe whether the optional `wreq-js` napi backend can be resolved without
 * triggering the full ~654ms cold-start load. Uses `require.resolve` so a
 * missing prebuilt binary for the host platform returns `false` instead of
 * throwing at lazy-import time.
 */
function probeWreqJsAvailable(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req.resolve('wreq-js');
    return true;
  } catch {
    return false;
  }
}

/**
 * Format the engine-health summary for doctor output. Pure so the lines can
 * be asserted from tests without spinning up the whole CLI. Returns one
 * string per line (no trailing newlines). Adds per-engine
 * status visibility for the cold-start health check.
 *
 *   ok        → "  bing            general    ok"
 *   needs-key → "  github-code     code       needs-key (set WIGOLO_GITHUB_TOKEN ...)"
 *   disabled  → "  brave           general    disabled (set BRAVE_API_KEY ...)"
 *
 * Sorted by vertical then engine name so the same registry produces the
 * same output every run.
 */
export function formatEngineHealthLines(entries: EngineHealthEntry[]): string[] {
  if (entries.length === 0) {
    return ['  (no engines configured)'];
  }
  const sorted = [...entries].sort((a, b) => {
    if (a.vertical !== b.vertical) return a.vertical.localeCompare(b.vertical);
    return a.name.localeCompare(b.name);
  });
  const lines: string[] = [];
  for (const e of sorted) {
    const name = e.name.padEnd(15);
    const vertical = e.vertical.padEnd(10);
    const suffix: string = e.status !== 'ok' && e.hint ? `${e.status} (${e.hint})` : e.status;
    // An open/half-open breaker means the engine will not dispatch
    // even though its config status says "ok" — render it with the last
    // upstream error so users see WHY the engine is dark.
    const breakerNote =
      e.breaker && e.breaker !== 'closed'
        ? ` [breaker ${e.breaker}${e.lastError ? ` — ${e.lastError.slice(0, 60)}` : ''}]`
        : '';
    // An informational note about a KNOWN, non-user-fixable
    // limitation (e.g. mojeek IP-reputation 403s). Rendered even for "ok"
    // engines so doctor is honest about why an engine may go dark.
    const limitationNote = e.note ? ` — note: ${e.note}` : '';
    lines.push(`  ${name} ${vertical} ${suffix}${breakerNote}${limitationNote}`);
  }
  return lines;
}

/**
 * Live per-engine probe behind `doctor --probe-engines`. Dedupes
 * the registered entries by engine name, skips parked (disabled) adapters,
 * and runs one bounded query per engine SEQUENTIALLY — politeness beats
 * speed for a diagnostic that hits 15+ third-party services. No-op when
 * the flag is off so the default doctor stays network-free.
 */
export async function runEngineProbeSection(
  probeEngines: boolean,
  entries: EngineEntry[],
  print: (line: string) => void = out,
): Promise<void> {
  if (!probeEngines) return;
  print('');
  print('[wigolo doctor] Engine probes (live):');
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.engine.name;
    if (entry.disabled || seen.has(name)) continue;
    seen.add(name);
    const t0 = Date.now();
    try {
      const results = await entry.engine.search('wigolo health probe', {
        maxResults: 3,
        timeoutMs: 5000,
      });
      print(`  ${name.padEnd(15)} ok (${Date.now() - t0}ms, ${results.length} results)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      print(`  ${name.padEnd(15)} error (${msg.slice(0, 80)})`);
    }
  }
}

/**
 * Build the `tls_tier` doctor line. Pure so it stays unit-testable.
 *
 *   WIGOLO_TLS_TIER=off  → `off (default)`
 *   WIGOLO_TLS_TIER=auto → `auto (chrome_142, wreq-js ✓)` when wreq-js loaded
 *                          `auto (wreq-js missing — fallback only)` when not
 *   WIGOLO_TLS_TIER=on   → `on (chrome_142, wreq-js ✓)` etc.
 */
export function formatTlsTierLine(
  mode: 'off' | 'auto' | 'on',
  browser: string,
  wreqAvailable: boolean,
): string {
  if (mode === 'off') return 'off (default)';
  if (!wreqAvailable) return `${mode} (wreq-js missing — fallback only)`;
  return `${mode} (${browser}, wreq-js ✓)`;
}

/**
 * Build the Ollama (local LLM server) diagnostic lines for doctor. Pure so the
 * branching can be asserted without a live server.
 *
 *   - ollama is the active provider → show resolved base URL + model (always,
 *     even when the server is mid-run unreachable — runtime falls back
 *     gracefully, doctor should still report what's configured).
 *   - no LLM configured AND a local server is reachable → emit an enable-hint.
 *   - otherwise → no lines (don't nag a user who already configured an LLM, and
 *     stay silent when no local server is present).
 *
 * The hint NEVER auto-enables anything; it only tells the user the lever exists.
 */
/**
 * Strip control / ANSI bytes from an untrusted string before printing it to the
 * terminal. A compromised localhost server could return an ANSI-laden model
 * name; rendering it verbatim is a terminal-injection vector. Security LOW.
 */
export function sanitizeForTerminal(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, '');
}

/**
 * Resolve the active-ollama model for display, bounded by a short timeout so a
 * stalled (connection-accepted-then-silent) server can never hang doctor. When
 * the pick times out / fails, returns undefined and doctor degrades gracefully
 * (the active section still prints the base URL). `pick` is injected for tests.
 */
export async function resolveOllamaModelBounded(
  baseUrl: string,
  pick: (url: string, fetchImpl: typeof fetch, signal: AbortSignal) => Promise<string> = pickOllamaModel,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await pick(baseUrl, fetch, controller.signal);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function buildOllamaDoctorLines(state: {
  llmConfigured: boolean;
  ollamaActive: boolean;
  reachable: boolean;
  baseUrl: string;
  model?: string;
}): string[] {
  if (state.ollamaActive) {
    const lines = [`  local LLM (ollama): ${sanitizeForTerminal(state.baseUrl)}`];
    if (state.model) lines.push(`    model:     ${sanitizeForTerminal(state.model)}`);
    if (!state.reachable) {
      lines.push('    note:      server not reachable now — research falls back to keyless synthesis');
    }
    return lines;
  }
  const hint = maybeOllamaHint({
    reachable: state.reachable,
    llmConfigured: state.llmConfigured,
    baseUrl: state.baseUrl,
  });
  return hint ? [`  ${hint}`] : [];
}

/**
 * Build the opt-in local-model tier (`WIGOLO_LOCAL_LLM`) diagnostic lines. Pure
 * so the branching is asserted without a live server. Component names (local
 * model server / model name) are allowed in doctor output.
 *
 *   - off               → state the flag is off (default) so the lever stays
 *                          discoverable; no endpoint is implied.
 *   - auto + reachable   → resolved endpoint + model + "reachable".
 *   - auto + unreachable → "enabled, no local model detected" so an
 *                          enabled-but-absent server is visible, not hidden.
 */
export function buildLocalTierDoctorLines(state: {
  localLlm: string;
  tier: LocalModelTier | null;
}): string[] {
  if (state.localLlm === 'off') {
    return [
      '  local language model (WIGOLO_LOCAL_LLM): off (default) — set to `auto` to auto-detect a keyless local model server',
    ];
  }
  const lines = [`  local language model (WIGOLO_LOCAL_LLM=${sanitizeForTerminal(state.localLlm)}):`];
  if (state.tier) {
    lines.push(`    endpoint:  ${sanitizeForTerminal(state.tier.endpoint)} (reachable)`);
    lines.push(`    model:     ${sanitizeForTerminal(state.tier.model)}`);
  } else {
    lines.push('    status:    enabled, no local model detected — synthesis falls back to keyless');
  }
  return lines;
}

function humanRetry(nextRetryAt?: string): string {
  if (!nextRetryAt) return 'not scheduled';
  const when = new Date(nextRetryAt);
  const mins = Math.round((when.getTime() - Date.now()) / 60_000);
  if (mins < 0) return `${nextRetryAt} (ready now)`;
  if (mins < 60) return `${nextRetryAt} (in ${mins} minutes)`;
  const hrs = Math.round(mins / 60);
  return `${nextRetryAt} (in ${hrs} hours)`;
}

/**
 * Exit code contract:
 * - 0 when all required components OK, or only optional packages (content extractor/ML reranker) missing.
 * - 1 when any required component is degraded: Python missing, browser missing,
 *   search engine bootstrap failed/no_runtime, or search engine process supposed to be up but isn't.
 */
export interface DoctorOptions {
  /** Run a live search probe against every registered engine. */
  probeEngines?: boolean;
  /** Attempt an automatic repair for every failed check with a known fix. */
  fix?: boolean;
  /** Emit a machine-readable JSON report on stdout (logs still go to stderr). */
  json?: boolean;
}

/** One diagnosable component in the doctor report. `fixable` marks checks that
 * `--fix` knows how to repair. */
export interface DoctorCheck {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  fixable: boolean;
  detail?: string;
}

/** Before/after record for one repair `--fix` attempted. */
export interface DoctorFix {
  name: string;
  action: string;
  before: 'ok' | 'failed' | 'skipped';
  after: 'ok' | 'failed' | 'skipped';
  ok: boolean;
  error?: string;
}

/** The machine-readable doctor report emitted under `--json`. */
export interface DoctorReport {
  status: 'ok' | 'degraded';
  exitCode: number;
  /** Running package version — for cross-channel support triage. */
  version: string;
  /** How wigolo was installed: `binary` (packaged executable) or `npm-or-source`. */
  install_channel: 'binary' | 'npm-or-source';
  checks: DoctorCheck[];
  fixes: DoctorFix[];
}

/** Whether the daemon appears to be running (a live admin token + a reachable
 * /health). Used to decide whether to ALSO POST the breaker reset to the daemon
 * (its breaker Map is separate from this CLI process's). */
async function daemonReachable(dataDir: string): Promise<boolean> {
  const token = readAdminToken(dataDir);
  if (!token) return false;
  try {
    const cfg = getConfig();
    const resp = await fetch(`http://${cfg.daemonHost}:${cfg.daemonPort}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok || resp.status === 503;
  } catch {
    return false;
  }
}

/** POST the authed breaker reset to a running daemon. Best-effort: a failure is
 * reported but never turns doctor into a hard failure (the in-process reset
 * already happened). */
async function postDaemonBreakerReset(dataDir: string): Promise<{ ok: boolean; error?: string }> {
  const token = readAdminToken(dataDir);
  if (!token) return { ok: false, error: 'no admin token on disk' };
  try {
    const cfg = getConfig();
    const resp = await fetch(`http://${cfg.daemonHost}:${cfg.daemonPort}/admin/reset-breakers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return { ok: false, error: `daemon returned HTTP ${resp.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Collect the checks `--fix` knows how to repair. Each returns `ok`/`failed`
 * with a fixable flag. Pure snapshots — no side effects — so they can be run
 * before AND after a repair to build the before/after record.
 *
 * Exported as the shared cold-check surface: `init` reuses it after a full
 * warmup to append a doctor summary (component presence, browser installed,
 * data-dir writable, breakers) WITHOUT a live network verify. Every check here
 * is presence/snapshot-only — none downloads a model or spawns a browser — so
 * it is safe to run on a `--no-warmup` init too (writes zero bytes).
 */
export async function runDoctorColdChecks(dataDir: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const pw = await checkPlaywright();
  checks.push({
    name: 'browser',
    status: pw.browsers.chromium ? 'ok' : 'failed',
    fixable: true,
    detail: pw.browsers.chromium ? 'chromium launchable' : 'chromium missing',
  });

  const emb = checkFastembedCache(dataDir);
  checks.push({
    name: 'embeddings',
    status: emb.installed ? 'ok' : 'failed',
    fixable: true,
    detail: emb.installed ? 'model cached' : (emb.reason ?? 'model missing'),
  });

  // searxng bootstrap: only a fixable failure when the sidecar is opted into.
  // On core (default) a failed/absent state is EXPECTED, not a failure — report
  // it skipped and non-fixable so the wipe never runs (D9 hard gate).
  const configured = searxngConfigured(getConfig());
  const state = getBootstrapState(dataDir) as BootstrapState | null;
  const bootstrapFailed = state?.status === 'failed';
  const staleLock = detectStaleSearxngLock(dataDir);
  if (!configured) {
    checks.push({ name: 'searxng', status: 'skipped', fixable: false, detail: 'sidecar not configured (core backend)' });
  } else if (bootstrapFailed || staleLock) {
    checks.push({ name: 'searxng', status: 'failed', fixable: true, detail: bootstrapFailed ? 'bootstrap failed' : 'stale lock/port files' });
  } else {
    checks.push({ name: 'searxng', status: 'ok', fixable: true, detail: state?.status ?? 'ready' });
  }

  const openBreakers = getBreakerSnapshot().filter((b) => b.state !== 'closed');
  checks.push({
    name: 'breakers',
    status: openBreakers.length > 0 ? 'failed' : 'ok',
    fixable: true,
    detail: openBreakers.length > 0 ? `${openBreakers.length} open/half-open` : 'all closed',
  });

  // Data-dir writability — non-fixable (a permissions problem doctor can't
  // repair) but a real failure that must surface at diagnosis time.
  const wr = checkDataDirWritable(dataDir);
  checks.push({
    name: 'data-dir',
    status: wr.writable ? 'ok' : 'failed',
    fixable: false,
    detail: wr.writable ? `writable (${dataDir})` : (wr.reason ?? 'not writable'),
  });

  return checks;
}

/** Whether a stale searxng lock/port file is present (process dead / unparseable). */
function detectStaleSearxngLock(dataDir: string): boolean {
  const lockPath = join(dataDir, 'searxng.lock');
  if (!existsSync(lockPath)) return existsSync(join(dataDir, 'searxng.port'));
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: number };
    return !(lock.pid && isProcessAlive(lock.pid));
  } catch {
    return true; // unparseable lock = stale
  }
}

/**
 * Run repairs for every failed, fixable check and return the before/after
 * records. Re-checks after each repair so the report reflects the real
 * post-repair state.
 */
async function applyDoctorFixes(dataDir: string, checks: DoctorCheck[]): Promise<DoctorFix[]> {
  const fixes: DoctorFix[] = [];
  const configured = searxngConfigured(getConfig());

  for (const check of checks) {
    if (check.status !== 'failed' || !check.fixable) continue;

    if (check.name === 'browser') {
      out(`[wigolo doctor] --fix: installing browser engine (chromium)...`);
      const r = await installBrowser('chromium');
      const after = (await checkPlaywright()).browsers.chromium ? 'ok' : 'failed';
      fixes.push({ name: 'browser', action: 'installBrowser(chromium)', before: 'failed', after, ok: r.ok && after === 'ok', error: r.error });
      out(`[wigolo doctor] --fix: browser ${after}`);
    } else if (check.name === 'embeddings') {
      out(`[wigolo doctor] --fix: downloading embeddings model...`);
      const r = await installEmbeddings();
      const after = checkFastembedCache(dataDir).installed ? 'ok' : 'failed';
      fixes.push({ name: 'embeddings', action: 'installEmbeddings()', before: 'failed', after, ok: r.embeddings === 'ok' && after === 'ok', error: r.embeddingsError });
      out(`[wigolo doctor] --fix: embeddings ${after}`);
    } else if (check.name === 'searxng') {
      // Hard gate: only wipe when the sidecar is opted into. On core this branch
      // is unreachable (check is skipped/non-fixable) — belt-and-braces here.
      if (!configured) continue;
      out(`[wigolo doctor] --fix: wiping stale search-engine state...`);
      wipeSearxngState(dataDir);
      const staleAfter = detectStaleSearxngLock(dataDir);
      const stateAfter = (getBootstrapState(dataDir) as BootstrapState | null)?.status;
      // Wipe clears the locks; a failed bootstrap still needs a warmup, so the
      // check may remain failed — report honestly.
      const after: DoctorFix['after'] = !staleAfter && stateAfter !== 'failed' ? 'ok' : 'failed';
      fixes.push({
        name: 'searxng',
        action: 'wipeSearxngState()',
        before: 'failed',
        after,
        ok: after === 'ok',
        error: after === 'failed' ? 'locks cleared; run `wigolo warmup --searxng` to re-bootstrap' : undefined,
      });
      out(`[wigolo doctor] --fix: search-engine state ${after === 'ok' ? 'cleared' : 'cleared (re-bootstrap needed)'}`);
    } else if (check.name === 'breakers') {
      out(`[wigolo doctor] --fix: resetting search-engine circuit breakers...`);
      resetBreakers();
      let error: string | undefined;
      if (await daemonReachable(dataDir)) {
        const daemonReset = await postDaemonBreakerReset(dataDir);
        if (!daemonReset.ok) error = `daemon reset failed: ${daemonReset.error}`;
        else out(`[wigolo doctor] --fix: daemon breakers reset via admin route`);
      }
      const after = getBreakerSnapshot().some((b) => b.state !== 'closed') ? 'failed' : 'ok';
      fixes.push({ name: 'breakers', action: 'resetBreakers()', before: 'failed', after, ok: after === 'ok', error });
      out(`[wigolo doctor] --fix: breakers ${after === 'ok' ? 'reset' : 'still open'}`);
    }
  }

  return fixes;
}

export async function runDoctor(dataDir: string, opts?: DoctorOptions): Promise<number> {
  // Doctor produces its own human-readable diagnostic — suppress info/debug
  // logger noise from the modules it touches so the output stays clean.
  // Warnings and errors still come through.
  setLogSuppression('warn');
  try {
    return await runDoctorInner(dataDir, opts);
  } finally {
    setLogSuppression(null);
  }
}

async function runDoctorInner(dataDir: string, opts?: DoctorOptions): Promise<number> {
  let degraded = false;
  // A degraded contributor doctor cannot repair (python + docker both missing).
  // Kept separate so the --fix exit-code recompute can tell "unfixable failure
  // remains" apart from the fixable browser/searxng contributions.
  let nonFixableDegraded = false;

  out(`[wigolo doctor] Data dir:        ${dataDir}`);
  const writable = checkDataDirWritable(dataDir);
  if (writable.writable) {
    out('  Writable:      yes');
  } else {
    out(`  Writable:      NO — ${writable.reason ?? 'not writable'}`);
    degraded = true;
    nonFixableDegraded = true;
  }
  out('');

  const py = checkPython();
  const dk = checkDocker();
  out('[wigolo doctor] Runtime:');
  out(`  Python 3:      ${py.ok ? `available (${py.version ?? 'unknown'})` : 'not available'}`);
  out(`  Docker:        ${dk.ok ? `available (${dk.cli}, ${dk.version})` : 'not available'}`);
  // python/docker are prerequisites ONLY for the opt-in search-engine sidecar
  // (bootstrap + --fix repair). On the default core backend their absence is
  // healthy — same gate the searxng section and runDoctorColdChecks use.
  if (searxngConfigured(getConfig()) && !py.ok && !dk.ok) { degraded = true; nonFixableDegraded = true; }

  out('');
  const pw = await checkPlaywright();
  out('[wigolo doctor] Browser engine:');
  out(`  Installation:  ${pw.installed ? `installed${pw.version ? ` (v${pw.version})` : ''}` : 'not installed'}`);
  out(`  Browsers:      chromium ${pw.browsers.chromium ? 'OK' : 'missing'}  firefox ${pw.browsers.firefox ? 'OK' : 'missing'}  webkit ${pw.browsers.webkit ? 'OK' : 'missing'}`);
  if (pw.chromiumPath) {
    const onDiskNote = pw.browsers.chromium
      ? ''
      : pw.chromiumOnDisk
        ? ' (on disk but will not launch)'
        : ' (missing on disk)';
    out(`  Chromium path: ${pw.chromiumPath}${onDiskNote}`);
  }
  if (!pw.browsers.chromium) {
    if (pw.chromiumOnDisk) {
      // Binary present but launch failed — a broken install, NOT a fresh one.
      // lazy ≠ blind: a corrupt browser degrades so the user acts on it.
      if (process.platform === 'linux') {
        out('  Hint:          system libraries missing — run: sudo npx playwright install-deps chromium');
      } else {
        out("  Hint:          on disk but will not launch — reinstall: 'npx playwright install chromium'");
      }
      // Fixable via reinstall, so leave nonFixableDegraded alone — a --fix run
      // can still clear this.
      degraded = true;
    } else {
      // Not on disk at all — lazily acquired on first fetch use. Absence at
      // diagnosis time is expected on a fresh install, not a failure.
      out('  Status:        lazy — downloads on first use (`wigolo warmup --browser` pre-caches)');
    }
  }

  out('');
  out('[wigolo doctor] Fetch tiers:');
  const tlsCfg = getConfig();
  const wreqAvailable = probeWreqJsAvailable();
  out(`  tls_tier:      ${formatTlsTierLine(tlsCfg.tlsTier, tlsCfg.tlsBrowser, wreqAvailable)}`);

  out('');
  const reranker = checkReranker(dataDir);
  const embeddings = checkFastembedCache(dataDir);
  out('[wigolo doctor] Optional components:');
  if (reranker.installed) {
    out(`  ML reranker:        installed (cross-encoder)`);
  } else {
    out(`  ML reranker:        not installed${reranker.reason ? ` (${reranker.reason})` : ''}`);
  }
  if (embeddings.installed) {
    out(`  Embeddings model:   installed (fastembed BGE-small-en-v1.5)`);
  } else {
    out(`  Embeddings model:   not installed${embeddings.reason ? ` (${embeddings.reason})` : ''}`);
  }

  out('');
  out('[wigolo doctor] LLM (extract / research / agent):');
  const cfg = getConfig();
  const active = selectProvider(process.env);
  for (const p of allProviders()) {
    const envVar = providerEnvVar(p);
    // Alias-aware: accept the canonical var OR a back-compat alias (e.g. gemini's
    // GOOGLE_API_KEY), matching how synthesis actually resolves the key — else
    // doctor would report "no key" for a key that synthesis happily uses.
    const envKey = providerKeyFromEnv(p, process.env);
    const envSet = !!envKey;
    // Check keystore for this provider (async — use readKey)
    let keyLocation: 'keychain' | 'file' | 'env' | 'none' = 'none';
    let maskedKey: string | undefined;
    try {
      const ksResult = await readKey(p, { dataDir: cfg.dataDir });
      if (ksResult) {
        keyLocation = ksResult.location;
        maskedKey = maskApiKey(ksResult.value);
      } else if (envSet) {
        keyLocation = 'env';
        maskedKey = maskApiKey(envKey ?? '');
      }
    } catch {
      // keystore read failure — fall back to env-only display
      if (envSet) {
        keyLocation = 'env';
        maskedKey = maskApiKey(envKey ?? '');
      }
    }
    const configured = keyLocation !== 'none';
    const activeMark = p === active ? ' <- active' : '';
    out(
      `  ${p.padEnd(10)} ${configured ? `configured (${keyLocation})` : 'no key'} (${envVar}${envSet ? '' : ' unset'})${activeMark}`,
    );
    if (configured && maskedKey) {
      out(`    key (masked): ${maskedKey}`);
    }
    if (configured) {
      const model = resolveModel(p, undefined, process.env);
      const modelEnv = providerModelEnvVar(p);
      const usingDefault = model === providerDefaultModel(p) && !process.env[modelEnv] && !process.env.WIGOLO_LLM_MODEL;
      out(`    model:     ${model}${usingDefault ? ' (default)' : ''}`);
      if (p === 'gemini' && /pro/i.test(model)) {
        out(`    warning:   gemini pro models hit the free-tier 0/day quota — switch WIGOLO_LLM_MODEL_GEMINI to gemini-2.5-flash or gemini-2.5-flash-lite`);
      }
    }
  }
  if (cfg.llmProvider) {
    if (cfg.llmProvider.startsWith('http://') || cfg.llmProvider.startsWith('https://')) {
      out(`  override:    custom URL (${cfg.llmProvider})`);
    } else {
      out(`  override:    WIGOLO_LLM_PROVIDER=${cfg.llmProvider}`);
    }
  }
  if (process.env.WIGOLO_LLM_MODEL) {
    out(`  WIGOLO_LLM_MODEL: ${process.env.WIGOLO_LLM_MODEL} (universal override)`);
  }
  out(`  cache TTL:   ${cfg.llmCacheTtlDays} days`);
  out(`  per-request: ${cfg.llmMaxCallsPerRequest} call(s) max`);

  // Local LLM server (Ollama) autodetect. Never auto-enables — when ollama is
  // active we report the resolved base/model; otherwise, when no LLM is
  // configured and a local server answers, we hint at the keyless lever. The
  // probe is fail-safe: a down/slow/absent server never errors or stalls.
  {
    const ollamaBackend = resolveCustomBackend(process.env);
    const ollamaActive = ollamaBackend?.isOllama ?? false;
    const llmConfigured = isLlmConfigured(process.env);
    const baseUrl = ollamaBackend?.isOllama ? ollamaBackend.url : resolveProbeBaseUrl(process.env);
    // Skip the network probe when ollama isn't active and an LLM is already
    // configured — there's nothing to hint at, so don't spend the round-trip.
    const needProbe = ollamaActive || !llmConfigured;
    const probe = needProbe ? await probeOllama(baseUrl) : { reachable: false };
    let model: string | undefined;
    if (ollamaActive && probe.reachable && !process.env.WIGOLO_LLM_MODEL) {
      // Bounded — a server that accepts the connection then stalls must never
      // hang doctor (the unbounded fetch this replaces could). Times out into
      // a graceful "no model" rather than blocking.
      model = await resolveOllamaModelBounded(baseUrl);
    } else if (ollamaActive) {
      model = process.env.WIGOLO_LLM_MODEL;
    }
    for (const line of buildOllamaDoctorLines({
      llmConfigured,
      ollamaActive,
      reachable: probe.reachable,
      baseUrl,
      model,
    })) {
      out(line);
    }
  }

  // Opt-in local-model tier (WIGOLO_LOCAL_LLM). Off by default — the line is
  // still printed so the lever is discoverable, but the resolver (and its fast,
  // negative-cached probe) is only invoked when the flag is on.
  {
    const localLlm = cfg.localLlm;
    const tier = localLlm === 'off' ? null : await resolveLocalModelTier({ localLlm, localLlmModel: cfg.localLlmModel });
    for (const line of buildLocalTierDoctorLines({ localLlm, tier })) {
      out(line);
    }
  }

  out('');
  out('[wigolo doctor] Search backend:');
  const rawBackend = process.env.WIGOLO_SEARCH;
  const aliased = rawBackend === 'v1' ? 'core (alias from v1, deprecated)' : null;
  const normalized = rawBackend === undefined || rawBackend === '' || rawBackend === 'v1'
    ? 'core'
    : rawBackend;
  const valid = ['core', 'searxng', 'hybrid'].includes(normalized);
  const renderBackend = (name: string): string =>
    name === normalized ? `* ${name}` : `  ${name}`;
  out(`  Backend:       ${aliased ?? normalized}${valid ? '' : ' (unknown — falling back to core)'} (default: core)`);
  out(`  Modes:         ${renderBackend('core')}   ${renderBackend('searxng')}   ${renderBackend('hybrid')}`);
  if (normalized === 'hybrid') {
    const { SIGNAL_NAMES } = await import('../search/hybrid/signals.js');
    out(`  hybrid mode:   core runs first; falls back to searxng + RRF merge when any signal fires`);
    out(`  signals:       ${SIGNAL_NAMES.join(', ')}`);
  }

  // Cold-start engine health summary. Registry-level — we don't
  // dispatch a live query; we just inspect the pools + the env-var contract.
  // Broken engines surface visibly without blocking startup or doctor exit.
  out('');
  out('[wigolo doctor] Search engines:');
  try {
    const engineHealth = getEngineHealthSummary();
    for (const line of formatEngineHealthLines(engineHealth)) {
      out(line);
    }
  } catch (err) {
    // Engine pool construction should never throw, but degrade gracefully if
    // a vertical fails to load — doctor must keep going.
    const msg = err instanceof Error ? err.message : String(err);
    out(`  (engine health summary failed: ${msg.slice(0, 80)})`);
  }

  // Opt-in live probe of every registered engine. Off by default —
  // doctor stays network-free unless the user explicitly asks.
  try {
    await runEngineProbeSection(opts?.probeEngines ?? false, getRegisteredEngineEntries());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`  (engine probes failed: ${msg.slice(0, 80)})`);
  }

  // The search-engine sidecar sections only apply when the sidecar backend is
  // opted into. On the default core backend an absent bootstrap is EXPECTED,
  // not a failure — skip the whole section (same gate runDoctorColdChecks
  // uses at the top of this file) instead of degrading on a missing state.json.
  const state = getBootstrapState(dataDir) as BootstrapState | null;
  if (searxngConfigured(getConfig())) {
    out('');
    out('[wigolo doctor] Search engine:');
    if (!state) {
      out('  status:        not bootstrapped — run `npx wigolo warmup`');
      degraded = true;
    } else if (state.status === 'ready') {
      out(`  status:        ready`);
      out(`  path:          ${state.searxngPath ?? 'unknown'}`);
    } else {
      out(`  status:        ${state.status}`);
      if (state.attempts !== undefined) out(`  attempts:      ${state.attempts} / 3`);
      if (state.lastAttemptAt) out(`  lastAttemptAt: ${state.lastAttemptAt}`);
      if (state.nextRetryAt || state.status === 'failed') out(`  nextRetryAt:   ${humanRetry(state.nextRetryAt)}`);
      if (state.lastError?.command) out(`  command:       ${state.lastError.command}`);
      if (state.lastError?.exitCode !== undefined) out(`  exit code:     ${state.lastError.exitCode}`);
      if (state.lastError?.message) out(`  message:       ${state.lastError.message}`);
      if (state.lastError?.stderr) {
        out('  stderr:');
        for (const line of state.lastError.stderr.split('\n').slice(0, 20)) out(`    ${line}`);
      }
      degraded = true;
    }

    out('');
    const lockPath = join(dataDir, 'searxng.lock');
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: number; port?: number };
        if (lock.pid && isProcessAlive(lock.pid)) {
          out(`[wigolo doctor] Search engine process:  running (pid ${lock.pid}, port ${lock.port ?? '?'})`);
        } else {
          out('[wigolo doctor] Search engine process:  stale lock (process exited) — will be cleaned on next start');
        }
      } catch {
        out('[wigolo doctor] Search engine process:  lock file unparseable — will be cleaned on next start');
      }
    } else {
      out('[wigolo doctor] Search engine process:  not running (starts on-demand with MCP server)');
    }

    if (state?.status === 'failed') {
      out('');
      out('[wigolo doctor] Recovery:');
      if (state.nextRetryAt) out(`  - Wait until next auto-retry (${humanRetry(state.nextRetryAt)}), or`);
      out(`  - Force retry now: npx wigolo warmup --force`);
    }
  }

  checkCoreEmbeddings(dataDir);
  await checkSqliteVec(dataDir);
  checkCacheStats(dataDir);
  checkBackgroundQueue(dataDir);
  checkRssFeeds(dataDir);
  checkTelemetryStatus();
  checkTuiEnv();

  if (normalized === 'searxng' || normalized === 'hybrid') {
    out('');
    out(`[wigolo doctor] Mode '${normalized}' note:`);
    if (state?.status === 'ready') {
      out('  search engine: ready (will be used for this backend)');
    } else {
      out(`  search engine: not ready — ${normalized === 'hybrid' ? 'hybrid will degrade to core-only' : 'searxng calls will fail'}`);
    }
  }

  // --fix pass: repair every failed, fixable check, then recompute status from
  // the post-fix fixable checks + the unfixable degraded contributor. Without
  // --fix the original `degraded` verdict is authoritative (preserves the
  // report-only exit-code contract).
  let fixes: DoctorFix[] = [];
  let fixableChecks = await runDoctorColdChecks(dataDir);
  if (opts?.fix) {
    out('');
    fixes = await applyDoctorFixes(dataDir, fixableChecks);
    if (fixes.length === 0) out('[wigolo doctor] --fix: nothing to repair');
    // Re-collect so the report + status reflect the repaired state.
    fixableChecks = await runDoctorColdChecks(dataDir);
    const anyFixableStillFailed = fixableChecks.some((c) => c.status === 'failed');
    degraded = nonFixableDegraded || anyFixableStillFailed;
  }

  const status: DoctorReport['status'] = degraded ? 'degraded' : 'ok';
  const exitCode = degraded ? 1 : 0;

  out('');
  out(`[wigolo doctor] Overall: ${degraded ? 'DEGRADED' : 'OK'}`);

  if (opts?.json) {
    const report: DoctorReport = {
      status,
      exitCode,
      version: getVersion(),
      install_channel: detectInstallChannel(),
      checks: fixableChecks,
      fixes,
    };
    // Machine shape on stdout; the human diagnostic above stays on stderr.
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }

  return exitCode;
}

// Passive cache-presence probe — reports whether the embedding model is on
// disk WITHOUT loading it (loading downloads on a fresh dir). The download
// belongs to `--fix`/warmup only. Mirrors checkFastembedCache's directory.
function checkCoreEmbeddings(dataDir: string): void {
  out('');
  out('[wigolo doctor] Core embeddings:');
  const cache = checkFastembedCache(dataDir);
  if (cache.installed) {
    out('  provider:      installed (fastembed BGE-small-en-v1.5)');
  } else {
    out('  provider:      not installed (lazy — downloads on first use)');
  }
}

async function checkSqliteVec(dataDir: string): Promise<void> {
  out('');
  out('[wigolo doctor] Core sqlite-vec:');
  let opened = false;
  try {
    const db = initDatabase(join(dataDir, 'wigolo.db'));
    opened = true;
    try {
      const row = db.prepare('SELECT vec_version() AS v').get() as { v?: string } | undefined;
      const v = row?.v ?? 'unknown';
      out(`  extension:     loaded (vec_version ${v})`);
    } catch {
      out('  extension:     not loaded (run warmup to load on next start)');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`  extension:     (check failed: ${msg.slice(0, 80)})`);
  } finally {
    if (opened) {
      try { closeDatabase(); } catch { /* ignore */ }
    }
  }
}

function checkCacheStats(dataDir: string): void {
  out('');
  out('[wigolo doctor] Local cache:');
  let opened = false;
  try {
    initDatabase(join(dataDir, 'wigolo.db'));
    opened = true;
    const stats = getCacheStats();
    if (stats.total_urls === 0) {
      out('  urls:          0 (cache empty — populate via fetch/crawl)');
    } else {
      out(`  urls:          ${stats.total_urls}`);
      out(`  size:          ${stats.total_size_mb.toFixed(2)} MB`);
      if (stats.oldest) out(`  oldest:        ${stats.oldest}`);
      if (stats.newest) out(`  newest:        ${stats.newest}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`  (check failed: ${msg.slice(0, 80)})`);
  } finally {
    if (opened) {
      try { closeDatabase(); } catch { /* ignore */ }
    }
  }
}

function checkBackgroundQueue(dataDir: string): void {
  out('');
  out('[wigolo doctor] Background embedding queue:');
  let opened = false;
  try {
    initDatabase(join(dataDir, 'wigolo.db'));
    opened = true;
    const queue = getBackgroundIndexQueue();
    const pending = queue.pendingSize();
    if (pending === 0) {
      out('  pending:       0 (idle)');
    } else {
      out(`  pending:       ${pending} job(s) — draining on next worker tick`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`  (check failed: ${msg.slice(0, 80)})`);
  } finally {
    if (opened) {
      try { closeDatabase(); } catch { /* ignore */ }
    }
  }
}

function checkRssFeeds(dataDir: string): void {
  out('');
  out('[wigolo doctor] RSS feeds:');
  try {
    const { feeds } = loadFeedConfig({ dataDir });
    if (feeds.length === 0) {
      out('  feeds:         none configured (set WIGOLO_RSS_FEEDS to opt in)');
      return;
    }

    let db: ReturnType<typeof initDatabase> | null = null;
    try {
      db = initDatabase(join(dataDir, 'wigolo.db'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out(`  feeds:         ${feeds.length} configured (db unreadable: ${msg.slice(0, 60)})`);
      return;
    }

    let stmt: ReturnType<typeof db.prepare> | null = null;
    try {
      stmt = db.prepare(
        'SELECT COUNT(*) AS n, MAX(fetched_at) AS last_at FROM feed_items WHERE feed_url = ?',
      );
    } catch {
      // feed_items table missing — treat every feed as never polled.
    }

    try {
      const now = Date.now();
      for (const feed of feeds) {
        let line: string;
        if (!stmt) {
          line = `  ${feed.url}  0 items [never polled]`;
        } else {
          try {
            const row = stmt.get(feed.url) as { n?: number; last_at?: string | null } | undefined;
            const n = row?.n ?? 0;
            const lastAt = row?.last_at ?? null;
            if (!lastAt) {
              line = `  ${feed.url}  ${n} items [never polled]`;
            } else {
              const ageMs = now - new Date(lastAt).getTime();
              const ageHr = ageMs / 3_600_000;
              const fresh = ageHr <= 24 ? 'fresh' : 'stale';
              const ageLabel = ageHr < 1
                ? `${Math.max(0, Math.round(ageMs / 60_000))}m ago`
                : `${Math.round(ageHr)}h ago`;
              const day = lastAt.slice(0, 10);
              line = `  ${feed.url}  ${n} items, last fetched ${day} (${ageLabel}) [${fresh}]`;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            line = `  ${feed.url}  (check failed: ${msg.slice(0, 60)})`;
          }
        }
        out(line);
      }
    } finally {
      try { closeDatabase(); } catch { /* ignore */ }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`  (check failed: ${msg.slice(0, 80)})`);
  }
}

function checkTelemetryStatus(): void {
  out('');
  const state = isTelemetryEnabled() ? 'enabled' : 'disabled';
  out(`[wigolo doctor] Telemetry: opt-in ${state} (WIGOLO_TELEMETRY=1 to opt in)`);
}

function checkTuiEnv(): void {
  out('');
  out('[wigolo doctor] TUI env:');
  const reducedMotion = process.env.WIGOLO_TUI_REDUCED_MOTION;
  const reducedMotionActive =
    reducedMotion === '1' ||
    process.env.CI === 'true' ||
    process.env.CI === '1' ||
    process.stdout.isTTY === false;
  out(
    `  WIGOLO_TUI_REDUCED_MOTION: ${reducedMotion ?? '(unset)'}` +
      ` — ${reducedMotionActive ? 'reduced motion active' : 'animations enabled'}` +
      ` (set to 1 to disable spinners/gradient/transitions in the settings TUI)`,
  );
}

const DOCTOR_CHILD_ENV = 'WIGOLO_DOCTOR_CHILD';

// Cosmetic libc++ abort messages emitted AFTER the child's diagnostic is
// already complete. The onnxruntime global thread pool races libc++ during
// static destructor teardown on macOS; we strip these lines from inherited
// child stderr so users do not see a fake-looking crash trailer.
export function isPostExitNativeNoise(line: string): boolean {
  return (
    line.startsWith('libc++abi:') ||
    line.includes('mutex lock failed: Invalid argument') ||
    line.includes('terminating due to uncaught exception')
  );
}

/**
 * Doctor isolation wrapper.
 *
 * `runDoctor` loads the embedding model (onnxruntime-node) to verify it
 * works. Onnxruntime owns a global thread pool that races libc++ during
 * static-destructor teardown on macOS, surfacing as
 * `mutex lock failed: Invalid argument` and a SIGABRT (exit 134) AFTER the
 * diagnostic output has already been written. The crash is unrecoverable
 * from JS — `session.release()`, `process.reallyExit`, and the SIGABRT
 * handler all run too early; the abort fires during C++ global dtors when
 * the JS VM is gone.
 *
 * Fix: run doctor in a child process. The child inherits stdio so the user
 * sees identical output, runs the diagnostic, writes its intended exit code
 * to a sentinel file, then exits. The parent never loads onnxruntime so its
 * own exit is clean. If the child crashes with SIGABRT (134) after the
 * sentinel was written, we know the diagnostic completed and we use the
 * sentinel code. Any other crash propagates as a real failure.
 */
export async function runDoctorIsolated(dataDir: string, opts?: DoctorOptions): Promise<number> {
  // Child mode: run doctor in-process, write intended exit code to sentinel.
  const sentinel = process.env[DOCTOR_CHILD_ENV];
  if (sentinel) {
    const code = await runDoctor(dataDir, opts);
    try {
      writeFileSync(sentinel, String(code), 'utf-8');
    } catch {
      // sentinel write failure means the parent can't see our code — fall
      // through to direct exit, parent will treat 134 as a real crash.
    }
    return code;
  }

  // Parent mode: spawn child, wait, read sentinel.
  return runDoctorAsChild(dataDir, opts);
}

export async function runDoctorAsChild(dataDir: string, opts?: DoctorOptions): Promise<number> {
  // Allow opt-out for environments where spawning is undesirable (tests,
  // sandboxed CI). The fallback runs doctor in-process — the libc++ abort
  // is still possible but the exit code from runDoctor itself is returned.
  if (process.env.WIGOLO_DOCTOR_INPROC === '1') {
    return runDoctor(dataDir, opts);
  }

  const sentinelDir = mkdtempSync(join(tmpdir(), 'wigolo-doctor-'));
  const sentinelPath = join(sentinelDir, 'exit-code');
  const env = { ...process.env, [DOCTOR_CHILD_ENV]: sentinelPath };

  // Re-invoke the same entrypoint. process.argv[1] is the wigolo dist entry
  // (or the bin shim) — passing it back gives us argv[0]=node, argv[1]=entry,
  // argv[2]=doctor.
  const entry = process.argv[1];
  if (!entry) {
    // Defensive: no entry to re-invoke. Fall back to in-process.
    return runDoctor(dataDir, opts);
  }

  // Inherit stdout, but pipe stderr so we can strip the cosmetic libc++ abort
  // message that fires after the child's diagnostic has completed. --json writes
  // its machine object to the child's stdout, which passes through via the
  // inherited fd — so the JSON survives the child-process isolation path.
  const childArgs = [
    entry,
    'doctor',
    ...(opts?.probeEngines ? ['--probe-engines'] : []),
    ...(opts?.fix ? ['--fix'] : []),
    ...(opts?.json ? ['--json'] : []),
  ];
  const code: number = await new Promise((resolve) => {
    const child = spawn(process.execPath, childArgs, {
      stdio: ['inherit', 'inherit', 'pipe'],
      env,
    });

    if (child.stderr) {
      let buf = '';
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!isPostExitNativeNoise(line)) {
            process.stderr.write(`${line}\n`);
          }
        }
      });
      child.stderr.on('end', () => {
        if (buf && !isPostExitNativeNoise(buf)) {
          process.stderr.write(buf);
        }
      });
    }

    child.on('exit', (exitCode, signal) => {
      // Prefer the sentinel value when present — it reflects the diagnostic
      // result regardless of post-exit native crashes.
      try {
        if (existsSync(sentinelPath)) {
          const raw = readFileSync(sentinelPath, 'utf-8').trim();
          const n = Number(raw);
          if (Number.isInteger(n) && n >= 0 && n <= 255) {
            resolve(n);
            return;
          }
        }
      } catch {
        // fall through to native exit code
      }
      if (typeof exitCode === 'number') {
        resolve(exitCode);
        return;
      }
      if (signal) {
        // Signal-terminated with no sentinel → treat as crash.
        resolve(1);
        return;
      }
      resolve(1);
    });
    child.on('error', () => resolve(1));
  });

  try { unlinkSync(sentinelPath); } catch { /* ignore */ }
  try { rmdirSync(sentinelDir); } catch { /* ignore */ }
  return code;
}
