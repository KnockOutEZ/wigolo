import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getConfig } from '../config.js';
import { searxngConfigured } from '../searxng/enabled.js';
import { probeBrowser, type BrowserName } from '../fetch/browser-probe.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../searxng/bootstrap.js';
import { checkVenvModule, venvInstallHint } from '../python-env.js';
import { isProcessAlive } from '../searxng/process.js';
import { getRerankProvider } from '../providers/rerank-provider.js';
import { runCommand } from './tui/run-command.js';
import type { WarmupReporter } from './tui/reporter.js';
import { noopReporter } from './tui/reporter.js';
import { autoReporter } from './tui/reporter-auto.js';
import { runVerify as runVerifyTui } from './tui/verify.js';
import { sanitizeForTerminal } from './doctor.js';
import { resolveLocalModelTier, type LocalModelTier } from '../integrations/cloud/llm/local-tier.js';

/**
 * Resolve the CLI entrypoint of the *bundled* Playwright module — the same
 * `playwright` the rest of wigolo imports for `chromium.launch()` and the
 * doctor parity probe. Installing via this path (instead of `npx playwright`,
 * which resolves Playwright independently and may pick a different version)
 * guarantees the install revision matches the revision doctor/runtime resolve.
 *
 * The `playwright` package declares `bin.playwright = "cli.js"` but does not
 * export `./cli.js` via the `exports` map, so we resolve `package.json` and
 * join the bin path rather than `require.resolve('playwright/cli.js')`.
 */
function resolveBundledPlaywrightCli(): string {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve('playwright/package.json');
  const pkg = req('playwright/package.json') as { bin?: string | Record<string, string> };
  const binRel =
    typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.playwright ?? 'cli.js';
  return join(dirname(pkgPath), binRel);
}

/**
 * Whether the current process can install OS system libraries without blocking
 * on an interactive password prompt:
 *  - root  → run `install-deps` directly (no sudo).
 *  - else, if `sudo -n true` exits 0 → passwordless sudo is configured.
 *  - else  → no (must SKIP; never invoke sudo, it could hang the TUI / CI).
 *
 * Returns the strategy so the caller can build the exact command.
 */
async function detectDepsStrategy(): Promise<'root' | 'sudo' | 'skip'> {
  if (process.getuid?.() === 0) return 'root';
  // `sudo -n true` never prompts: -n makes sudo fail immediately (non-zero)
  // rather than ask for a password when credentials aren't cached.
  try {
    const probe = await runCommand('sudo', ['-n', 'true'], { timeout: 5000 });
    return probe.code === 0 ? 'sudo' : 'skip';
  } catch {
    // No sudo binary at all (spawn ENOENT — e.g. slim containers). runCommand
    // REJECTS on spawn errors, so without this catch the whole browser install
    // crashes before the launch smoke-test. Same verdict as a failed probe.
    return 'skip';
  }
}

/**
 * Linux-only: install the OS shared libs Chromium/Firefox/WebKit need at
 * runtime (libnss3, libatk, libgbm, ...). The browser binary install puts the
 * executable on disk, but on bare Linux `launch()` still fails without these
 * libs. macOS/Windows bundle them, so this is skipped off Linux.
 *
 * Returns whether deps were installed; `skipped` means we deliberately did NOT
 * run sudo (non-root, no passwordless sudo) so the launch smoke-test can emit
 * an actionable remediation hint instead of hanging on a password prompt.
 */
async function installLinuxDeps(
  browser: BrowserName,
  cli: string,
): Promise<{ installed: boolean; skipped: boolean; error?: string }> {
  if (process.platform !== 'linux') return { installed: false, skipped: false };

  const strategy = await detectDepsStrategy();
  if (strategy === 'skip') return { installed: false, skipped: true };

  const cmd = strategy === 'sudo' ? 'sudo' : process.execPath;
  const args =
    strategy === 'sudo'
      ? ['-n', process.execPath, cli, 'install-deps', browser]
      : [cli, 'install-deps', browser];

  const r = await runCommand(cmd, args, { timeout: 180000 });
  if (r.code !== 0) {
    const message = (r.stderr || r.stdout || `exit ${r.code}`).trim();
    return { installed: false, skipped: false, error: message };
  }
  return { installed: true, skipped: false };
}

/**
 * Install a browser via the bundled Playwright CLI: spawn node against the
 * resolved cli.js so the install uses the SAME Playwright revision the rest of
 * the code resolves.
 *
 * Three steps, in order:
 *   1. Install the browser binary as the CURRENT user (binaries land in the
 *      user's cache, never root's).
 *   2. (Linux only) Install OS system libs via `install-deps` — as root if we
 *      are root, via passwordless `sudo -n` if available, else SKIP.
 *   3. Smoke-test by actually launching the browser headless (via the shared
 *      probe doctor also uses). A clean install exit is NOT trusted on its own
 *      (GH #116): the binary can be on disk yet fail to launch when system libs
 *      are missing. Only a successful launch reports `ok`.
 */
/**
 * Strip Playwright's npx-global warning box from captured install output.
 *
 * When wigolo runs via `npx wigolo`, the bundled Playwright CLI resolves from an
 * `_npx` cache path, so `playwright install` ALWAYS prints an ASCII-box warning
 * ("running 'npx playwright install' without first installing your project's
 * dependencies"). It is harmless — the install continues — but on a genuine
 * failure the box leads the captured stderr, and naively surfacing the first
 * line reports the border (`╔═══╗`) as the "error". Every banner line begins
 * with a box-drawing glyph, so dropping those lines removes the whole box
 * regardless of width or wording and leaves only the real error text.
 */
function stripNpxGlobalBanner(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*[╔╚╝╗║╠╣╦╩╬═]/.test(line))
    .join('\n');
}

/**
 * Build the surfaced error for a failed browser install. A timeout is the most
 * common slow/restricted-network failure, so it gets an explicit, actionable
 * message (retry / mirror) instead of the half-drawn progress bar it left in the
 * captured streams. Otherwise: merge BOTH streams — a real download error can
 * land on stdout, which the old `stderr || stdout` dropped whenever the npx
 * banner filled stderr — strip the npx-global banner, and fall back to the exit
 * code when nothing else was printed.
 */
export function sanitizeBrowserInstallError(
  stdout: string,
  stderr: string,
  code: number,
  timedOut = false,
): string {
  if (timedOut) {
    return 'browser download timed out (slow or restricted network). Retry `wigolo warmup --browser`, or point PLAYWRIGHT_DOWNLOAD_HOST at a mirror.';
  }
  const merged = [stderr, stdout].filter(Boolean).join('\n');
  const cleaned = stripNpxGlobalBanner(merged).trim();
  return cleaned || `exit ${code}`;
}

// Browser binaries are 90–170 MB each. 180s was too tight for slow/throttled
// links (a field driver of masked install "failures"); 300s covers ~1 Mbps. One
// retry absorbs a transient reset/error — but NOT a timeout: a timeout already
// spent the full budget, and a fresh (non-resuming) re-download would just time
// out again, so we fail fast with the mirror hint instead of doubling the wait.
const BROWSER_INSTALL_TIMEOUT_MS = 300_000;
const BROWSER_INSTALL_ATTEMPTS = 2;

export async function installBrowser(
  browser: BrowserName,
): Promise<{ ok: boolean; error?: string }> {
  const cli = resolveBundledPlaywrightCli();
  let r = await runCommand(process.execPath, [cli, 'install', browser], {
    timeout: BROWSER_INSTALL_TIMEOUT_MS,
  });
  for (let attempt = 2; r.code !== 0 && !r.timedOut && attempt <= BROWSER_INSTALL_ATTEMPTS; attempt++) {
    r = await runCommand(process.execPath, [cli, 'install', browser], {
      timeout: BROWSER_INSTALL_TIMEOUT_MS,
    });
  }
  if (r.code !== 0) {
    return { ok: false, error: sanitizeBrowserInstallError(r.stdout, r.stderr, r.code, r.timedOut) };
  }

  // A deps failure (root / passwordless sudo path) is not a hard error on its
  // own — the launch smoke-test below is the real check. deps.error only
  // surfaces if launch also fails.
  const deps = await installLinuxDeps(browser, cli);

  // Launch smoke-test via the shared probe — same result doctor reports.
  const probe = await probeBrowser(browser);
  if (probe.launchable) return { ok: true };

  if (!probe.onDisk) {
    return {
      ok: false,
      error: 'install exited 0 but browser binary missing on disk (revision mismatch?)',
    };
  }

  // Binary present but launch failed. On Linux with deps skipped, this is
  // almost always missing OS libs — give the EXACT remediation command.
  if (process.platform === 'linux' && deps.skipped) {
    return {
      ok: false,
      error: `system libraries missing — install them with:\n  sudo npx playwright install-deps ${browser}\nThen re-run: wigolo warmup`,
    };
  }
  const detail = probe.error ?? deps.error ?? 'browser failed to launch';
  return { ok: false, error: `browser failed to launch: ${detail}` };
}

export interface WarmupResult {
  playwright: 'ok' | 'failed';
  playwrightError?: string;
  searxng: 'ready' | 'bootstrapped' | 'failed' | 'no_python' | 'no_venv' | 'skipped';
  searxngError?: string;
  reranker?: 'ok' | 'failed';
  rerankerError?: string;
  firefox?: 'ok' | 'failed';
  firefoxError?: string;
  webkit?: 'ok' | 'failed';
  webkitError?: string;
  embeddings?: 'ok' | 'failed';
  embeddingsError?: string;
}

/**
 * Map the internal WarmupResult to the machine-facing --json shape, renaming the
 * implementation-library keys to capability names (`playwright` → `browserEngine`,
 * `searxng` → `searchSidecar`) so the JSON contract carries no library names —
 * the same rule the OpenAPI surface enforces. The internal type keeps its field
 * names; the rename happens only at this serialization boundary. Optional fields
 * are copied through unchanged.
 */
export function warmupResultToJson(result: WarmupResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    browserEngine: result.playwright,
    searchSidecar: result.searxng,
  };
  if (result.playwrightError !== undefined) out.browserEngineError = result.playwrightError;
  if (result.searxngError !== undefined) out.searchSidecarError = result.searxngError;
  if (result.reranker !== undefined) out.reranker = result.reranker;
  if (result.rerankerError !== undefined) out.rerankerError = result.rerankerError;
  if (result.firefox !== undefined) out.firefox = result.firefox;
  if (result.firefoxError !== undefined) out.firefoxError = result.firefoxError;
  if (result.webkit !== undefined) out.webkit = result.webkit;
  if (result.webkitError !== undefined) out.webkitError = result.webkitError;
  if (result.embeddings !== undefined) out.embeddings = result.embeddings;
  if (result.embeddingsError !== undefined) out.embeddingsError = result.embeddingsError;
  return out;
}

/**
 * Format the opt-in local-model tier (`WIGOLO_LOCAL_LLM`) summary line for
 * warmup. Pure so the branching is asserted without a live server. warmup does
 * not install models — it only reports the resolved state. Component names
 * (local model server / model name) are allowed in warmup output.
 */
export function formatLocalLlmWarmupLine(state: {
  localLlm: string;
  tier: LocalModelTier | null;
}): string {
  if (state.localLlm === 'off') {
    return '  Local language model: off (default — set WIGOLO_LOCAL_LLM=auto to auto-detect a keyless local model)';
  }
  if (state.tier) {
    return `  Local model:   reachable at ${sanitizeForTerminal(state.tier.endpoint)} (${sanitizeForTerminal(state.tier.model)})`;
  }
  return `  Local model:   ${sanitizeForTerminal(state.localLlm)} — not reachable (synthesis falls back to keyless)`;
}

export function wipeSearxngState(dataDir: string, reporter: WarmupReporter = noopReporter): void {
  const bootstrapLockPath = join(dataDir, 'bootstrap.lock');
  if (existsSync(bootstrapLockPath)) {
    try {
      const lock = JSON.parse(readFileSync(bootstrapLockPath, 'utf-8')) as { pid?: number };
      if (lock.pid && isProcessAlive(lock.pid)) {
        throw new Error(
          `Cannot --force: another wigolo bootstrap is in progress (pid ${lock.pid}). ` +
          `Kill it first: kill ${lock.pid}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Cannot --force')) throw err;
    }
  }
  rmSync(join(dataDir, 'state.json'), { force: true });
  rmSync(join(dataDir, 'searxng'), { recursive: true, force: true });
  rmSync(bootstrapLockPath, { force: true });
  rmSync(join(dataDir, 'searxng.lock'), { force: true });
  rmSync(join(dataDir, 'searxng.port'), { force: true });
  reporter.note('Wiped search engine state, install, and locks (--force)');
}

async function installPlaywright(reporter: WarmupReporter): Promise<Pick<WarmupResult, 'playwright' | 'playwrightError'>> {
  reporter.start('playwright', 'Installing browser engine (chromium)');
  const r = await installBrowser('chromium');
  if (r.ok) {
    reporter.success('playwright', 'installed');
    return { playwright: 'ok' };
  }
  const [headline, ...notes] = (r.error ?? 'install failed').split('\n');
  reporter.fail('playwright', headline);
  for (const line of notes) reporter.note(line);
  return { playwright: 'failed', playwrightError: headline };
}

async function installReranker(
  reporter: WarmupReporter,
): Promise<Pick<WarmupResult, 'reranker' | 'rerankerError'>> {
  reporter.start('reranker', 'Downloading ML reranker model (cross-encoder)');
  try {
    const provider = await getRerankProvider();
    // Smoke-test end-to-end: warmup loads model + tokenizer, then a single
    // rerank call exercises the inference path.
    const scored = await provider.rerank('warmup', [
      { id: '0', text: 'hello world' },
    ]);
    if (scored.length !== 1) {
      throw new Error(`unexpected rerank shape (results=${scored.length})`);
    }
    reporter.success('reranker', `model ${provider.modelId} ready`);
    return { reranker: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.fail('reranker', message);
    return { reranker: 'failed', rerankerError: message };
  }
}

async function installFirefox(reporter: WarmupReporter): Promise<Pick<WarmupResult, 'firefox' | 'firefoxError'>> {
  reporter.start('firefox', 'Installing browser engine (firefox)');
  const r = await installBrowser('firefox');
  if (r.ok) {
    reporter.success('firefox', 'installed');
    return { firefox: 'ok' };
  }
  const [headline, ...notes] = (r.error ?? 'install failed').split('\n');
  reporter.fail('firefox', headline);
  for (const line of notes) reporter.note(line);
  return { firefox: 'failed', firefoxError: headline };
}

async function installWebkit(reporter: WarmupReporter): Promise<Pick<WarmupResult, 'webkit' | 'webkitError'>> {
  reporter.start('webkit', 'Installing browser engine (webkit)');
  const r = await installBrowser('webkit');
  if (r.ok) {
    reporter.success('webkit', 'installed');
    return { webkit: 'ok' };
  }
  const [headline, ...notes] = (r.error ?? 'install failed').split('\n');
  reporter.fail('webkit', headline);
  for (const line of notes) reporter.note(line);
  return { webkit: 'failed', webkitError: headline };
}

export async function installEmbeddings(reporter: WarmupReporter = noopReporter): Promise<Pick<WarmupResult, 'embeddings' | 'embeddingsError'>> {
  reporter.start('embeddings', 'Downloading semantic embeddings model (fastembed)');
  try {
    const { FastembedEmbedProvider } = await import('../embedding/fastembed-provider.js');
    const provider = new FastembedEmbedProvider();
    await provider.warmup();
    // Probe to ensure the ONNX model can actually produce a vector end-to-end.
    const [vec] = await provider.embed(['warmup']);
    if (!vec || vec.length !== provider.dim) {
      throw new Error(`unexpected embedding shape (dim=${vec?.length ?? 'undef'})`);
    }
    reporter.success('embeddings', `model ${provider.modelId} ready`);
    return { embeddings: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.fail('embeddings', message);
    return { embeddings: 'failed', embeddingsError: message };
  }
}

async function runSearxngPhase(dataDir: string, reporter: WarmupReporter): Promise<Pick<WarmupResult, 'searxng' | 'searxngError'>> {
  const state = getBootstrapState(dataDir);
  if (state?.status === 'ready') {
    reporter.start('searxng', 'Checking search engine (searxng)');
    reporter.success('searxng', 'already set up');
    return { searxng: 'ready' };
  }

  if (!checkPythonAvailable()) {
    reporter.start('searxng', 'Checking search engine (searxng)');
    reporter.fail('searxng', 'Python 3 not found — install Python 3 or set SEARXNG_MODE=docker');
    return { searxng: 'no_python' };
  }

  // The python3-venv package is not installed by default on Debian/Ubuntu.
  // Detecting it here lets us print an actionable apt hint and fall back to the
  // built-in core search backend instead of failing the whole warmup with a
  // cryptic ensurepip traceback.
  const venvCheck = checkVenvModule();
  if (!venvCheck.available) {
    const hint = venvInstallHint(venvCheck.pythonVersion);
    reporter.start('searxng', 'Checking search engine (searxng)');
    reporter.note(`Search engine (searxng): unavailable — ${hint}`);
    reporter.success('searxng', 'using core backend (no venv module)');
    return { searxng: 'no_venv', searxngError: hint };
  }

  reporter.start('searxng', 'Bootstrapping search engine (searxng) — this may take a minute');
  try {
    await bootstrapNativeSearxng(dataDir);
    reporter.success('searxng', 'bootstrapped');
    return { searxng: 'bootstrapped' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.fail('searxng', message);
    return { searxng: 'failed', searxngError: message };
  }
}

async function runVerify(dataDir: string, reporter: WarmupReporter): Promise<void> {
  reporter.note('');
  reporter.note('Verifying setup...');
  await runVerifyTui(dataDir, reporter);
  reporter.note('');
  reporter.note('✓ Done. Connect to your AI tool:');
  reporter.note('  claude mcp add wigolo --scope user -- npx wigolo');
}

export async function runWarmup(
  flags: string[] = [],
  reporter?: WarmupReporter,
): Promise<WarmupResult> {
  const flagSet = new Set(flags);
  const json = flagSet.has('--json');
  // --json implies plain: a TUI progress reporter would emit ANSI to stderr;
  // the machine result goes to stdout at the end, logs stay plain on stderr.
  const plain = flagSet.has('--plain') || json;
  const reporterImpl = reporter ?? autoReporter({ plain });

  const config = getConfig();

  if (flagSet.has('--force')) {
    wipeSearxngState(config.dataDir, reporterImpl);
  }

  reporterImpl.note('Starting wigolo warmup');

  const pwResult = await installPlaywright(reporterImpl);

  // D1: the search-engine sidecar is opt-in. The searxng phase runs only when
  // explicitly requested (`--searxng`), or with `--all` when the sidecar is
  // configured (searxng/hybrid backend or an external URL). A core-backend
  // `--all` installs browser + models only, killing the D1↔D8 hint
  // contradiction. `--no-searxng` is an ACTIVE suppressor and wins over both.
  const searxngRequested =
    flagSet.has('--searxng') || (flagSet.has('--all') && searxngConfigured(config));
  let searxngResult: Pick<WarmupResult, 'searxng' | 'searxngError'>;
  if (flagSet.has('--no-searxng') || !searxngRequested) {
    searxngResult = { searxng: 'skipped' };
    reporterImpl.note('Search engine sidecar: skipped — using multi-engine core backend');
  } else {
    searxngResult = await runSearxngPhase(config.dataDir, reporterImpl);
  }

  let rerankerResult: Pick<WarmupResult, 'reranker' | 'rerankerError'> = {};
  if (flagSet.has('--reranker') || flagSet.has('--all')) {
    rerankerResult = await installReranker(reporterImpl);
  }

  let firefoxResult: Pick<WarmupResult, 'firefox' | 'firefoxError'> = {};
  if (flagSet.has('--firefox') || flagSet.has('--all')) {
    firefoxResult = await installFirefox(reporterImpl);
  }

  let webkitResult: Pick<WarmupResult, 'webkit' | 'webkitError'> = {};
  if (flagSet.has('--webkit') || flagSet.has('--all')) {
    webkitResult = await installWebkit(reporterImpl);
  }

  let embeddingsResult: Pick<WarmupResult, 'embeddings' | 'embeddingsError'> = {};
  if (flagSet.has('--embeddings') || flagSet.has('--all')) {
    embeddingsResult = await installEmbeddings(reporterImpl);
  }

  const result: WarmupResult = {
    ...pwResult,
    ...searxngResult,
    ...rerankerResult,
    ...firefoxResult,
    ...webkitResult,
    ...embeddingsResult,
  };

  reporterImpl.note('');
  reporterImpl.note('Summary:');
  reporterImpl.note(`  Browser:       ${result.playwright}${result.playwrightError ? ` (${result.playwrightError})` : ''}`);
  reporterImpl.note(`  Search engine: ${result.searxng}${result.searxngError ? ` (${result.searxngError})` : ''}`);
  if (result.reranker) reporterImpl.note(`  ML reranker:   ${result.reranker}${result.rerankerError ? ` (${result.rerankerError})` : ''}`);
  if (result.firefox) reporterImpl.note(`  Firefox:       ${result.firefox}${result.firefoxError ? ` (${result.firefoxError})` : ''}`);
  if (result.webkit) reporterImpl.note(`  WebKit:        ${result.webkit}${result.webkitError ? ` (${result.webkitError})` : ''}`);
  if (result.embeddings) reporterImpl.note(`  Embeddings:    ${result.embeddings}${result.embeddingsError ? ` (${result.embeddingsError})` : ''}`);

  // Opt-in local-model tier state. Off by default — the line is still shown so
  // the lever is discoverable, but the resolver (and its fast, negative-cached
  // probe) runs only when the flag is on.
  const localLlm = config.localLlm ?? 'off';
  const localTier = localLlm === 'off'
    ? null
    : await resolveLocalModelTier({ localLlm, localLlmModel: config.localLlmModel ?? null });
  reporterImpl.note(formatLocalLlmWarmupLine({ localLlm, tier: localTier }));

  // `--all` implies a post-install verify, but a caller that runs its own
  // checks afterwards (init does doctor cold checks) passes `--skip-verify` to
  // avoid a redundant re-load of components the install phase already exercised.
  if ((flagSet.has('--verify') || flagSet.has('--all')) && !flagSet.has('--skip-verify')) {
    await runVerify(config.dataDir, reporterImpl);
  }

  reporterImpl.finish();

  if (json) {
    // Machine shape on stdout (capability-named keys, no library names); the
    // progress/summary lines stay on stderr.
    process.stdout.write(`${JSON.stringify(warmupResultToJson(result))}\n`);
  }

  return result;
}
