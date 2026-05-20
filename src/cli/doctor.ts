import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBootstrapState, type BootstrapState } from '../searxng/bootstrap.js';
import { isProcessAlive } from '../searxng/process.js';
import { getPythonBin } from '../python-env.js';
import { getConfig } from '../config.js';
import { resolveModelId } from '../search/reranker/models.js';
import { onnxRerank } from '../search/reranker/onnx.js';
import { allProviders, providerEnvVar } from '../integrations/cloud/llm/select.js';

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

function checkPlaywright(): { installed: boolean; version?: string; browsers: { chromium: boolean; chromiumHeadlessShell: boolean; firefox: boolean; webkit: boolean } } {
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
  // Browser detection — light check
  const probe = (browser: string): boolean => {
    const r = spawnSync('npx', ['playwright', 'install', '--dry-run', browser], { encoding: 'utf-8', timeout: 5000 });
    return r.status === 0 && !/is not installed/i.test(r.stdout + r.stderr);
  };
  return {
    installed,
    version,
    browsers: {
      chromium: probe('chromium'),
      chromiumHeadlessShell: probe('chromium-headless-shell'),
      firefox: probe('firefox'),
      webkit: probe('webkit'),
    },
  };
}

function checkPyPackage(name: string, pythonBin: string): { ok: boolean; version?: string } {
  const importCheck = spawnSync(pythonBin, ['-c', `import ${name}`], { encoding: 'utf-8' });
  if (importCheck.status !== 0 || importCheck.error) return { ok: false };
  const versionCheck = spawnSync(pythonBin, ['-c', `import ${name}; print(${name}.__version__)`], { encoding: 'utf-8' });
  if (versionCheck.status !== 0 || versionCheck.error) return { ok: true };
  const version = (versionCheck.stdout || '').trim();
  return { ok: true, version: version || undefined };
}

async function checkOnnxReranker(
  dataDir: string,
): Promise<{ installed: boolean; modelId?: string; rerankMs?: number; reason?: string }> {
  let modelId: string;
  try {
    modelId = resolveModelId(getConfig().rerankerModel);
  } catch (err) {
    return { installed: false, reason: err instanceof Error ? err.message : 'unknown error' };
  }
  const dir = join(dataDir, 'models', modelId);
  const required = ['model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json'];
  const missing = required.filter((f) => !existsSync(join(dir, f)));
  if (missing.length > 0) {
    return { installed: false, modelId, reason: `missing: ${missing.join(', ')}` };
  }
  try {
    const docs = [
      { text: 'React Server Components render on the server.' },
      { text: 'Next.js App Router uses RSC by default.' },
      { text: 'Bananas are a popular fruit.' },
      { text: 'TypeScript adds static types to JavaScript.' },
      { text: 'The capital of France is Paris.' },
    ];
    const t0 = Date.now();
    await onnxRerank('react server components', docs, { modelId });
    const rerankMs = Date.now() - t0;
    return { installed: true, modelId, rerankMs };
  } catch (err) {
    return { installed: false, modelId, reason: err instanceof Error ? err.message : 'rerank failed' };
  }
}

function checkRerankerPyPackages(pythonBin: string): {
  ok: boolean;
  tokenizers?: string;
  onnxruntime?: string;
} {
  const tok = checkPyPackage('tokenizers', pythonBin);
  const ort = checkPyPackage('onnxruntime', pythonBin);
  return {
    ok: tok.ok && ort.ok,
    tokenizers: tok.version,
    onnxruntime: ort.version,
  };
}

function checkVenvStale(dataDir: string, _pythonBin: string): { stale: boolean; reason?: string } {
  const cfgPath = join(dataDir, 'searxng', 'venv', 'pyvenv.cfg');
  if (!existsSync(cfgPath)) return { stale: false };
  try {
    const cfg = readFileSync(cfgPath, 'utf-8');
    const homeMatch = cfg.match(/home\s*=\s*(.+)$/m);
    if (!homeMatch) return { stale: false };
    const venvHome = homeMatch[1].trim();
    if (!existsSync(venvHome)) return { stale: true, reason: `recorded home ${venvHome} does not exist` };
    return { stale: false };
  } catch {
    return { stale: false };
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
  out(`  Browsers:      chromium ${pw.browsers.chromium ? 'OK' : 'missing'}  headless-shell ${pw.browsers.chromiumHeadlessShell ? 'OK' : 'missing'}  firefox ${pw.browsers.firefox ? 'OK' : 'missing'}  webkit ${pw.browsers.webkit ? 'OK' : 'missing'}`);
  if (!pw.installed || !pw.browsers.chromium || !pw.browsers.chromiumHeadlessShell) {
    if (!pw.browsers.chromiumHeadlessShell && pw.installed) {
      out("  Hint:          run 'npx playwright install chromium-headless-shell' — JS-rendered pages will fail without it");
    }
    degraded = true;
  }

  out('');
  const pythonBin = getPythonBin(dataDir);
  const traf = checkPyPackage('trafilatura', pythonBin);
  const reranker = await checkOnnxReranker(dataDir);
  out('[wigolo doctor] Optional components:');
  out(`  Content extractor:  ${traf.ok ? `installed (trafilatura${traf.version ? ` v${traf.version}` : ''})` : 'not installed'}`);
  if (reranker.installed) {
    const timing = reranker.rerankMs !== undefined ? ` — 5-doc rerank ${reranker.rerankMs}ms` : '';
    out(`  ML reranker:        installed (onnx ${reranker.modelId})${timing}`);
  } else {
    out(`  ML reranker:        not installed${reranker.reason ? ` (${reranker.reason})` : ''}`);
  }

  const pyPkgs = checkRerankerPyPackages(pythonBin);
  const versionPart = pyPkgs.tokenizers && pyPkgs.onnxruntime
    ? ` (tokenizers=${pyPkgs.tokenizers} onnxruntime=${pyPkgs.onnxruntime})`
    : '';
  out(`  Python reranker packages: ${pyPkgs.ok ? 'ok' : 'missing'}${versionPart}`);

  const venvCheck = checkVenvStale(dataDir, pythonBin);
  if (venvCheck.stale) {
    out(`  Python reranker venv:    STALE — re-run "wigolo warmup --reranker" (${venvCheck.reason})`);
  }

  out('');
  out('[wigolo doctor] LLM fallback (extract):');
  const cfg = getConfig();
  for (const p of allProviders()) {
    const envVar = providerEnvVar(p);
    const set = !!process.env[envVar];
    out(
      `  ${p.padEnd(10)} ${set ? 'configured' : 'no key'} (${envVar}${set ? '' : ' unset'})`,
    );
  }
  if (cfg.llmProvider) {
    out(`  override:    WIGOLO_LLM_PROVIDER=${cfg.llmProvider}`);
  }
  out(`  cache TTL:   ${cfg.llmCacheTtlDays} days`);
  out(`  per-request: ${cfg.llmMaxCallsPerRequest} call(s) max`);

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

  out('');
  out(`[wigolo doctor] Overall: ${degraded ? 'DEGRADED' : 'OK'}`);
  return degraded ? 1 : 0;
}
