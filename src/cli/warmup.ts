import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getConfig } from '../config.js';
import { probeBrowser, type BrowserName } from '../fetch/browser-probe.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../searxng/bootstrap.js';
import { checkVenvModule, venvInstallHint } from '../python-env.js';
import { isProcessAlive } from '../searxng/process.js';
import { getRerankProvider } from '../providers/rerank-provider.js';
import { runCommand } from './tui/run-command.js';
import type { WarmupReporter } from './tui/reporter.js';
import { autoReporter } from './tui/reporter-auto.js';
import { runVerify as runVerifyTui } from './tui/verify.js';

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
  const probe = await runCommand('sudo', ['-n', 'true'], { timeout: 5000 });
  return probe.code === 0 ? 'sudo' : 'skip';
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
async function installBrowser(
  browser: BrowserName,
): Promise<{ ok: boolean; error?: string }> {
  const cli = resolveBundledPlaywrightCli();
  const r = await runCommand(process.execPath, [cli, 'install', browser], { timeout: 180000 });
  if (r.code !== 0) {
    const message = (r.stderr || r.stdout || `exit ${r.code}`).trim();
    return { ok: false, error: message };
  }

  // A deps failure (root / passwordless sudo path) is not a hard error on its
  // own — the launch smoke-test below is the real check. deps.error only
  // surfaces if launch also fails.
  const deps = await installLinuxDeps(browser, cli);

  // Launch smoke-test via the shared probe — same verdict doctor reports.
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

function wipeSearxngState(dataDir: string, reporter: WarmupReporter): void {
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

async function installEmbeddings(reporter: WarmupReporter): Promise<Pick<WarmupResult, 'embeddings' | 'embeddingsError'>> {
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
  reporter.note('  claude mcp add wigolo -- npx @staticn0va/wigolo');
}

export async function runWarmup(
  flags: string[] = [],
  reporter?: WarmupReporter,
): Promise<WarmupResult> {
  const flagSet = new Set(flags);
  const plain = flagSet.has('--plain');
  const reporterImpl = reporter ?? autoReporter({ plain });

  const config = getConfig();

  if (flagSet.has('--force')) {
    wipeSearxngState(config.dataDir, reporterImpl);
  }

  reporterImpl.note('Starting wigolo warmup');

  const pwResult = await installPlaywright(reporterImpl);

  // The search engine (searxng) is an optional backend — `core` is the default
  // search path and needs no native bootstrap. `--no-searxng` lets the
  // Review/Toggles screen genuinely skip the searxng phase rather than only
  // relabeling its status.
  let searxngResult: Pick<WarmupResult, 'searxng' | 'searxngError'>;
  if (flagSet.has('--no-searxng')) {
    searxngResult = { searxng: 'skipped' };
    reporterImpl.note('Search engine (searxng): skipped — using core backend');
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

  if (flagSet.has('--verify') || flagSet.has('--all')) {
    await runVerify(config.dataDir, reporterImpl);
  }

  reporterImpl.finish();
  return result;
}
