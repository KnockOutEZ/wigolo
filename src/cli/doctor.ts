import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePythonExe } from '../python-env.js';
import { probeBrowser } from '../fetch/browser-probe.js';
import { getBootstrapState, type BootstrapState } from '../searxng/bootstrap.js';
import { isProcessAlive } from '../searxng/process.js';
import { getConfig } from '../config.js';
import { getRerankProvider } from '../providers/rerank-provider.js';
import { getEmbedProvider } from '../providers/embed-provider.js';
import { initDatabase, closeDatabase } from '../cache/db.js';
import { getCacheStats } from '../cache/store.js';
import { getBackgroundIndexQueue } from '../embedding/background-queue.js';
import { loadFeedConfig } from '../search/core/rss/feed-config.js';
import { getEngineHealthSummary, type EngineHealthEntry } from '../search/core/engine-health.js';
import { isTelemetryEnabled } from './telemetry.js';
import { allProviders, providerEnvVar, selectProvider } from '../integrations/cloud/llm/select.js';
import { resolveModel, providerDefaultModel, providerModelEnvVar } from '../integrations/cloud/llm/model-select.js';
import { readKey } from '../security/key-store.js';
import { setLogSuppression } from '../logger.js';

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

function checkDocker(): { ok: boolean; version?: string } {
  const r = spawnSync('docker', ['--version'], { encoding: 'utf-8' });
  if (r.status !== 0 || r.error) return { ok: false };
  return { ok: true, version: (r.stdout || '').trim() };
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

  // Use the SAME shared probe warmup uses (GH #116) so doctor cannot disagree
  // with warmup about browser health. The verdict is launchable — a real
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

async function checkReranker(
): Promise<{ installed: boolean; modelId?: string; rerankMs?: number; reason?: string }> {
  try {
    const provider = await getRerankProvider();
    const docs = [
      'React Server Components render on the server.',
      'Next.js App Router uses RSC by default.',
      'Bananas are a popular fruit.',
      'TypeScript adds static types to JavaScript.',
      'The capital of France is Paris.',
    ].map((text, i) => ({ id: String(i), text }));
    const t0 = Date.now();
    await provider.rerank('react server components', docs);
    const rerankMs = Date.now() - t0;
    return { installed: true, modelId: provider.modelId, rerankMs };
  } catch (err) {
    return { installed: false, reason: err instanceof Error ? err.message : 'rerank failed' };
  }
}

function checkFastembedCache(dataDir: string): { installed: boolean; reason?: string } {
  const cacheDir = join(dataDir, 'fastembed');
  if (!existsSync(cacheDir)) {
    return { installed: false, reason: 'cache dir missing — run `wigolo warmup --embeddings`' };
  }
  try {
    // First-run downloads create a model subdir with ONNX assets. Empty cache
    // dir means the model has not been fetched yet.
    const entries = readdirSync(cacheDir);
    if (entries.length === 0) {
      return { installed: false, reason: 'cache empty — run `wigolo warmup --embeddings`' };
    }
    return { installed: true };
  } catch (err) {
    return { installed: false, reason: err instanceof Error ? err.message : 'unknown error' };
  }
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
 * string per line (no trailing newlines). Slice S11a — adds per-engine
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
    lines.push(`  ${name} ${vertical} ${suffix}`);
  }
  return lines;
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
export async function runDoctor(dataDir: string): Promise<number> {
  // Doctor produces its own human-readable diagnostic — suppress info/debug
  // logger noise from the modules it touches so the output stays clean.
  // Warnings and errors still come through.
  setLogSuppression('warn');
  try {
    return await runDoctorInner(dataDir);
  } finally {
    setLogSuppression(null);
  }
}

async function runDoctorInner(dataDir: string): Promise<number> {
  let degraded = false;

  out(`[wigolo doctor] Data dir:        ${dataDir}`);
  out('');

  const py = checkPython();
  const dk = checkDocker();
  out('[wigolo doctor] Runtime:');
  out(`  Python 3:      ${py.ok ? `available (${py.version ?? 'unknown'})` : 'not available'}`);
  out(`  Docker:        ${dk.ok ? `available (${dk.version})` : 'not available'}`);
  if (!py.ok && !dk.ok) degraded = true;

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
    if (pw.chromiumOnDisk && process.platform === 'linux') {
      // Binary present but launch failed — on Linux this is almost always
      // missing OS shared libs. Give the exact remediation command.
      out('  Hint:          system libraries missing — run: sudo npx playwright install-deps chromium');
    } else {
      out("  Hint:          run 'npx playwright install chromium' — JS-rendered pages will fail without it");
    }
    degraded = true;
  }

  out('');
  out('[wigolo doctor] Fetch tiers:');
  const tlsCfg = getConfig();
  const wreqAvailable = probeWreqJsAvailable();
  out(`  tls_tier:      ${formatTlsTierLine(tlsCfg.tlsTier, tlsCfg.tlsBrowser, wreqAvailable)}`);

  out('');
  const reranker = await checkReranker();
  const embeddings = checkFastembedCache(dataDir);
  out('[wigolo doctor] Optional components:');
  if (reranker.installed) {
    const timing = reranker.rerankMs !== undefined ? ` — 5-doc rerank ${reranker.rerankMs}ms` : '';
    out(`  ML reranker:        installed (${reranker.modelId})${timing}`);
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
    const envSet = !!process.env[envVar];
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
        maskedKey = maskApiKey(process.env[envVar] ?? '');
      }
    } catch {
      // keystore read failure — fall back to env-only display
      if (envSet) {
        keyLocation = 'env';
        maskedKey = maskApiKey(process.env[envVar] ?? '');
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

  // Slice S11a: cold-start engine health summary. Registry-level — we don't
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

  out('');
  const state = getBootstrapState(dataDir) as BootstrapState | null;
  out('[wigolo doctor] Search engine:');
  if (!state) {
    out('  status:        not bootstrapped — run `npx @staticn0va/wigolo warmup`');
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
    out(`  - Force retry now: npx @staticn0va/wigolo warmup --force`);
  }

  await checkCoreEmbeddings();
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

  out('');
  out(`[wigolo doctor] Overall: ${degraded ? 'DEGRADED' : 'OK'}`);
  return degraded ? 1 : 0;
}

async function checkCoreEmbeddings(): Promise<void> {
  out('');
  out('[wigolo doctor] Core embeddings:');
  try {
    const provider = await getEmbedProvider();
    out(`  provider:      ready (fastembed ${provider.modelId}, dim=${provider.dim})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`  provider:      not ready (${msg.slice(0, 80)})`);
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
export async function runDoctorIsolated(dataDir: string): Promise<number> {
  // Child mode: run doctor in-process, write intended exit code to sentinel.
  const sentinel = process.env[DOCTOR_CHILD_ENV];
  if (sentinel) {
    const code = await runDoctor(dataDir);
    try {
      writeFileSync(sentinel, String(code), 'utf-8');
    } catch {
      // sentinel write failure means the parent can't see our code — fall
      // through to direct exit, parent will treat 134 as a real crash.
    }
    return code;
  }

  // Parent mode: spawn child, wait, read sentinel.
  return runDoctorAsChild(dataDir);
}

export async function runDoctorAsChild(dataDir: string): Promise<number> {
  // Allow opt-out for environments where spawning is undesirable (tests,
  // sandboxed CI). The fallback runs doctor in-process — the libc++ abort
  // is still possible but the exit code from runDoctor itself is returned.
  if (process.env.WIGOLO_DOCTOR_INPROC === '1') {
    return runDoctor(dataDir);
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
    return runDoctor(dataDir);
  }

  // Inherit stdout, but pipe stderr so we can strip the cosmetic libc++ abort
  // message that fires after the child's diagnostic has completed.
  const code: number = await new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, 'doctor'], {
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
