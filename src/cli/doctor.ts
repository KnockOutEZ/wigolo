import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { getBootstrapState, type BootstrapState } from '../searxng/bootstrap.js';
import { isProcessAlive } from '../searxng/process.js';
import { getConfig } from '../config.js';
import { getRerankProvider } from '../providers/rerank-provider.js';
import { getEmbedProvider } from '../providers/embed-provider.js';
import { initDatabase, closeDatabase } from '../cache/db.js';
import { loadFeedConfig } from '../search/core/rss/feed-config.js';
import { isTelemetryEnabled } from './telemetry.js';
import { allProviders, providerEnvVar, selectProvider } from '../integrations/cloud/llm/select.js';
import { resolveModel, providerDefaultModel, providerModelEnvVar } from '../integrations/cloud/llm/model-select.js';
import { setLogSuppression } from '../logger.js';

function out(line = ''): void { process.stderr.write(`${line}\n`); }

function checkPython(): { ok: boolean; version?: string } {
  const r = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
  if (r.status !== 0 || r.error) return { ok: false };
  const match = (r.stdout || r.stderr || '').match(/Python (\d+\.\d+\.\d+)/);
  return { ok: true, version: match?.[1] };
}

function checkDocker(): { ok: boolean; version?: string } {
  const r = spawnSync('docker', ['--version'], { encoding: 'utf-8' });
  if (r.status !== 0 || r.error) return { ok: false };
  return { ok: true, version: (r.stdout || '').trim() };
}

function checkPlaywright(): { installed: boolean; version?: string; browsers: { chromium: boolean; chromiumHeadlessShell: boolean; firefox: boolean; webkit: boolean }; chromiumPath?: string } {
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

  // Probe browser readiness by resolving the bundled Playwright's actual
  // executable path and checking the file on disk. This matches what fetch
  // uses via chromium.launch(), so doctor cannot lie about parity.
  const probeBrowser = (api: { executablePath(): string }): { ok: boolean; path?: string } => {
    try {
      const exec = api.executablePath();
      return { ok: !!exec && existsSync(exec), path: exec };
    } catch {
      return { ok: false };
    }
  };

  const chromiumProbe = probeBrowser(chromium);
  const firefoxProbe = probeBrowser(firefox);
  const webkitProbe = probeBrowser(webkit);

  // headless-shell uses chromium binary or a sibling; presence implied when
  // chromium ok. If a user explicitly needs the shell, fetch will surface
  // playwright_not_installed regardless.
  return {
    installed,
    version,
    browsers: {
      chromium: chromiumProbe.ok,
      chromiumHeadlessShell: chromiumProbe.ok,
      firefox: firefoxProbe.ok,
      webkit: webkitProbe.ok,
    },
    chromiumPath: chromiumProbe.path,
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
  const pw = checkPlaywright();
  out('[wigolo doctor] Browser engine:');
  out(`  Installation:  ${pw.installed ? `installed${pw.version ? ` (v${pw.version})` : ''}` : 'not installed'}`);
  out(`  Browsers:      chromium ${pw.browsers.chromium ? 'OK' : 'missing'}  firefox ${pw.browsers.firefox ? 'OK' : 'missing'}  webkit ${pw.browsers.webkit ? 'OK' : 'missing'}`);
  if (pw.chromiumPath) {
    out(`  Chromium path: ${pw.chromiumPath}${pw.browsers.chromium ? '' : ' (missing on disk)'}`);
  }
  if (!pw.browsers.chromium) {
    out("  Hint:          run 'npx playwright install chromium' — JS-rendered pages will fail without it");
    degraded = true;
  }

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
    const set = !!process.env[envVar];
    const activeMark = p === active ? ' <- active' : '';
    out(
      `  ${p.padEnd(10)} ${set ? 'configured' : 'no key'} (${envVar}${set ? '' : ' unset'})${activeMark}`,
    );
    if (set) {
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
  out(`  Backend:       ${aliased ?? normalized} (default: core)`);

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
  checkRssFeeds(dataDir);
  checkTelemetryStatus();

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
