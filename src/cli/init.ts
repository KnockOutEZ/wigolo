import { parseInitFlags, FlagParseError } from './tui/flags.js';
import type { LLMProvider } from '../integrations/cloud/llm/types.js';
import { probeOllama, resolveProbeBaseUrl, maybeOllamaHint } from './ollama-probe.js';
import { isPackagedBinary, BINARY_TUI_UNAVAILABLE_MESSAGE } from '../util/packaged.js';

/**
 * Probe for a local Ollama server and, when one is reachable AND no LLM is
 * configured, print a one-line discoverability hint. Fail-safe: a down/slow/
 * absent server never errors, stalls, or changes the exit code — covered by
 * probeOllama's bounded AbortSignal. NEVER auto-enables; hint only.
 *
 * `print` is injected so each init path routes through its own stdout/stderr
 * writer (no raw console.log). Used by BOTH the Ink and non-interactive paths.
 */
export async function maybePrintOllamaHint(print: (line: string) => void): Promise<void> {
  try {
    const { isLlmConfigured } = await import('../integrations/cloud/llm/run.js');
    const baseUrl = resolveProbeBaseUrl(process.env);
    const { reachable } = await probeOllama(baseUrl);
    const hint = maybeOllamaHint({ reachable, llmConfigured: isLlmConfigured(process.env), baseUrl });
    if (hint) print(hint);
  } catch {
    // Detection is best-effort — never let a hint failure affect init.
  }
}

const KEYSTORE_PROVIDERS: readonly LLMProvider[] = ['anthropic', 'openai', 'gemini', 'groq'];

/**
 * One-line hint printed on a `--no-warmup` init: nothing was pre-downloaded, so
 * components are acquired lazily on first use. The default init pre-caches them,
 * so this hint is only shown on the download-nothing path.
 */
const PRECACHE_HINT =
  'components download on first use — run `wigolo warmup --all` to pre-cache';

const INIT_USAGE = [
  'Usage: wigolo init [options]',
  '',
  'Sets up wigolo: detects and wires your agents, persists settings, and by',
  'default performs a COMPLETE setup — downloads the browser engine + on-device',
  'models, verifies them, and prints a per-component report so failures surface',
  'loudly. Pass --no-warmup to skip all downloads (components then lazy-load on',
  'first use).',
  '',
  'By default init uses the plain text flow. Pass --wizard to launch the',
  'interactive setup wizard (requires a terminal).',
  '',
  'Options:',
  '  --wizard                Launch the interactive setup wizard (Ink TUI)',
  '  --no-warmup             Skip ALL component downloads (lazy-load on first use)',
  '  --warmup                Explicit-on alias (full setup is the default; no-op)',
  '  --json                  Emit a machine-readable JSON summary on stdout',
  '  --non-interactive, -y   Skip interactive prompts (uses plain text flow)',
  '  --agents=<csv>          Comma-separated agent ids to auto-wire (optional; omit to set up the engine only and point any MCP client at wigolo yourself)',
  '  --skip-verify           Skip the post-install verify step',
  '  --plain                 Force plain (non-TUI) output',
  '  --provider=<name>       LLM provider for research/agent: anthropic|openai|gemini|ollama',
  '  --search=<backend>      Search backend: core|searxng|hybrid',
  '  --help, -h              Show this message',
  '',
  'Environment:',
  '  WIGOLO_LLM_API_KEY      LLM API key (never passed as a flag; read from env only)',
  '',
].join('\n');

/**
 * Per-component setup status for the --json summary. Capability-language keys
 * (browserEngine / embeddings / reranker) — no library names — matching the
 * warmup --json contract's rename boundary. `ready` when the component was
 * downloaded and verified; `failed` (with `error`) when the download failed;
 * `skipped` under --no-warmup (lazy-loads on first use, never a failure).
 */
type ComponentSetupStatus = 'ready' | 'failed' | 'skipped';

interface ComponentSummary {
  browserEngine: ComponentSetupStatus;
  browserEngineError?: string;
  embeddings: ComponentSetupStatus;
  embeddingsError?: string;
  reranker: ComponentSetupStatus;
  rerankerError?: string;
}

/**
 * One doctor cold-check result surfaced in the --json summary. Mirrors
 * doctor's DoctorCheck (name/status/detail) but drops the internal `fixable`
 * flag — the JSON consumer only needs to know each component's state.
 */
interface DoctorSummaryCheck {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  detail?: string;
}

/**
 * Map warmup's internal WarmupResult to the init --json per-component shape.
 * Under --no-warmup no warmup ran, so every component is `skipped` (lazy). A
 * failed download becomes `failed` + its error; anything else is `ready`.
 */
function componentSummaryFromWarmup(
  result: import('./warmup.js').WarmupResult | null,
): ComponentSummary {
  if (!result) {
    return { browserEngine: 'skipped', embeddings: 'skipped', reranker: 'skipped' };
  }
  const summary: ComponentSummary = {
    browserEngine: result.playwright === 'ok' ? 'ready' : 'failed',
    embeddings: result.embeddings === 'ok' ? 'ready' : 'failed',
    reranker: result.reranker === 'ok' ? 'ready' : 'failed',
  };
  if (summary.browserEngine === 'failed' && result.playwrightError) {
    summary.browserEngineError = result.playwrightError;
  }
  if (summary.embeddings === 'failed' && result.embeddingsError) {
    summary.embeddingsError = result.embeddingsError;
  }
  if (summary.reranker === 'failed' && result.rerankerError) {
    summary.rerankerError = result.rerankerError;
  }
  return summary;
}

/**
 * Run the full component setup (`runWarmup(['--all'])`) and NEVER throw: a
 * transient download failure must not fail init (the component lazy-retries on
 * first use). Returns the WarmupResult so the caller can build the per-component
 * report, or null when warmup itself threw (the whole result is then `failed`
 * with the thrown message applied to every component).
 *
 * `print` routes the actionable failure line + fix to the caller's own stderr
 * writer (no raw console.log).
 */
async function runFullSetup(
  reporter: import('./tui/reporter.js').WarmupReporter,
  print: (line: string) => void,
): Promise<import('./warmup.js').WarmupResult | null> {
  const { runWarmup } = await import('./warmup.js');
  try {
    return await runWarmup(['--all'], reporter);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Exit 0 even here: log the failure with the retry path, let the caller
    // still wire the agent + persist config. Components lazy-retry on first use.
    print(`Component setup failed: ${message}`);
    print('Fix: re-run `wigolo warmup --all` — components also lazy-retry on first use.');
    return null;
  }
}

/**
 * Print the per-component setup report + fixes for any failed download, then
 * run doctor cold checks and append their summary. Returns the doctor check
 * results for the --json summary. No live network verify — every doctor check
 * here is presence/snapshot-only (see runDoctorColdChecks).
 */
async function reportSetupAndDoctor(
  components: ComponentSummary,
  dataDir: string,
  print: (line: string) => void,
): Promise<DoctorSummaryCheck[]> {
  const label: Record<keyof Pick<ComponentSummary, 'browserEngine' | 'embeddings' | 'reranker'>, string> = {
    browserEngine: 'Browser engine',
    embeddings: 'Embeddings model',
    reranker: 'ML reranker',
  };
  const fix: Record<'browserEngine' | 'embeddings' | 'reranker', string> = {
    browserEngine: 're-run `wigolo warmup --all`, or `npx playwright install chromium`',
    embeddings: 're-run `wigolo warmup --all` (embeddings lazy-retry on first use)',
    reranker: 're-run `wigolo warmup --all` (reranker lazy-retries on first use)',
  };
  print('');
  print('  Component setup:');
  for (const key of ['browserEngine', 'embeddings', 'reranker'] as const) {
    const status = components[key];
    if (status === 'ready') {
      print(`  ✓ ${label[key]}: ready`);
    } else if (status === 'skipped') {
      print(`  ○ ${label[key]}: skipped (lazy — downloads on first use)`);
    } else {
      const err = key === 'browserEngine' ? components.browserEngineError
        : key === 'embeddings' ? components.embeddingsError
          : components.rerankerError;
      print(`  ✗ ${label[key]}: failed${err ? ` — ${err}` : ''}`);
      print(`    Fix: ${fix[key]}`);
    }
  }

  const { runDoctorColdChecks } = await import('./doctor.js');
  const checks = await runDoctorColdChecks(dataDir);
  print('');
  print('  Diagnostics (doctor cold checks):');
  const summary: DoctorSummaryCheck[] = [];
  for (const c of checks) {
    const glyph = c.status === 'ok' ? '✓' : c.status === 'skipped' ? '○' : '✗';
    print(`  ${glyph} ${c.name}: ${c.status}${c.detail ? ` — ${c.detail}` : ''}`);
    summary.push({ name: c.name, status: c.status, detail: c.detail });
  }
  return summary;
}

/**
 * Install skill packs for the selected agents through the shared skills engine.
 *
 * A single engine call (`installSkills`, global scope) covers every selected
 * agent the engine can target. Selected agents that have no skills destination
 * are filtered out against the engine's supported set, so passing e.g. `vscode`
 * or `zed` is a no-op rather than an error. The summary line is derived from the
 * engine's ApplyResult (files written vs. refused), replacing the old hardcoded
 * "8 skills installed" message.
 *
 * `print`, `ok`, `warn` are injected so this stays wired to the caller's own
 * stdout/stderr routing (no raw console.log).
 */
async function installSelectedSkills(
  selected: readonly string[],
  print: (line?: string) => void,
  ok: (s: string) => string,
  warn: (s: string) => string,
): Promise<void> {
  const { installSkills, SUPPORTED_AGENTS } = await import('./agents/skills/index.js');
  const supported = new Set<string>(SUPPORTED_AGENTS);
  const agents = selected.filter((id) => supported.has(id));
  if (agents.length === 0) return;

  try {
    const result = installSkills({ scope: 'global', agents, cwd: process.cwd() });
    const written = result.written.length;
    const refused = result.refused.length;
    if (written > 0) {
      print(`  ${ok(`Skills installed (${written} file${written === 1 ? '' : 's'} written)`)}`);
    } else {
      print(`  ${ok('Skills up to date (no changes)')}`);
    }
    if (refused > 0) {
      print(`  ${warn(`${refused} skill path(s) left untouched (modified or protected)`)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    print(`  ${warn(`Skills skipped: ${message}`)}`);
  }
}

export async function runInit(args: string[]): Promise<number> {
  let flags;
  try {
    flags = parseInitFlags(args);
  } catch (err) {
    if (err instanceof FlagParseError) {
      process.stderr.write(`${err.message}\n`);
      process.stderr.write(INIT_USAGE);
      return 2;
    }
    throw err;
  }

  if (flags.help) {
    process.stderr.write(INIT_USAGE);
    return 0;
  }

  const isTTY = Boolean(process.stdout.isTTY);
  const isCI =
    process.env.CI === 'true' ||
    process.env.CI === '1' ||
    process.env.GITHUB_ACTIONS === 'true';
  // Headless-first (D8): the plain path is the default on TTY and non-TTY alike.
  // Ink mounts ONLY under an explicit --wizard flag (and never in --plain /
  // --non-interactive / CI / non-TTY contexts, which can't host it).
  const useInk = flags.wizard && !flags.plain && !flags.nonInteractive && isTTY && !isCI;

  // The Ink TUI stack cannot boot inside the standalone binary (dependency-level
  // top-level await). Headless-first: surface the actionable fallback and route
  // to the fully-headless plain flow instead of crashing on an ESM-TLA require.
  if (useInk && isPackagedBinary()) {
    process.stderr.write(`${BINARY_TUI_UNAVAILABLE_MESSAGE}\n`);
    return runInitPlain(flags);
  }

  if (useInk) {
    return runInitWizard(flags);
  }

  // Plain / non-interactive mode — use the existing text-based flow
  return runInitPlain(flags);
}

/**
 * Machine-readable init summary emitted under --json. `status` drives the
 * exit code: 'ok' → 0, 'error' → non-zero.
 *
 * A component-download failure does NOT set status=error — init still wires the
 * agent + persists config and exits 0 (the component lazy-retries). status=error
 * is reserved for a genuine system hard-failure (Node too old, disk full).
 * `components` + `doctor` carry the per-component + diagnostic detail.
 */
interface InitJsonSummary {
  status: 'ok' | 'error';
  path: 'plain' | 'wizard';
  warmup: boolean;
  agentsRegistered: string[];
  configPersisted: boolean;
  components?: ComponentSummary;
  doctor?: DoctorSummaryCheck[];
  readyCount?: number;
  total?: number;
  requiredFailed?: boolean;
  message?: string;
}

function emitInitJson(summary: InitJsonSummary): void {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function runInitWizard(flags: InitFlagsResolved): Promise<number> {
  // Surface the keyless local-LLM lever before the wizard takes over the
  // terminal, so a user with a running Ollama server learns they can pick it
  // in the upcoming LLM step. Hint only — never auto-enabled.
  await maybePrintOllamaHint((line) => process.stderr.write(`${line}\n`));

  // Delegate to runConfig with --force-wizard: same code path, no divergent logic.
  // Don't forward --plain: this code path is reached only when useInk is true,
  // which already requires !flags.plain.
  const { runConfig } = await import('./config.js');
  const code = await runConfig(['--force-wizard']);
  if (code !== 0) {
    if (flags.json) {
      emitInitJson({ status: 'error', path: 'wizard', warmup: false, agentsRegistered: [], configPersisted: false, message: 'wizard exited non-zero' });
    }
    return code;
  }

  // If the user navigated to the uninstall screen and wiped wigolo mid-session,
  // skip warmup entirely — reinstalling components after an intentional uninstall
  // would recreate ~/.wigolo against the user's wishes.
  const { wasUninstalled } = await import('./tui/state/uninstall-signal.js');
  if (wasUninstalled()) {
    if (flags.json) {
      emitInitJson({ status: 'ok', path: 'wizard', warmup: false, agentsRegistered: [], configPersisted: false, message: 'uninstalled mid-session' });
    }
    return 0;
  }

  const { getConfig } = await import('../config.js');
  const dataDir = getConfig().dataDir;

  // Install skills for the agents the wizard selected. The wizard's finish step
  // persists `configuredAgents` into the SAME init-config the plain path writes;
  // read it back here (after the Ink shell has unmounted) and route it through
  // the identical shared engine call the plain path uses. Precedent: warmup runs
  // after the Ink shell unmounts too, for the same clean-terminal reason.
  let wizardAgents: string[] = [];
  try {
    const { readInitConfig } = await import('./tui/utils/config-writer.js');
    const persisted = readInitConfig(dataDir);
    const configured = persisted['configuredAgents'];
    wizardAgents = Array.isArray(configured)
      ? configured.filter((a): a is string => typeof a === 'string')
      : [];
    if (wizardAgents.length > 0) {
      const { ok, warn } = await import('./tui/format.js');
      await installSelectedSkills(
        wizardAgents,
        (line = '') => process.stderr.write(`${line}\n`),
        ok,
        warn,
      );
    }
  } catch (err) {
    // Best-effort: a skills-install failure never fails the wizard flow.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Skills skipped: ${message}\n`);
  }

  // Full setup (default): download every component, then run doctor cold checks
  // and print a per-component report. `--no-warmup` skips ALL downloads (the
  // component then lazy-loads on first use). Run AFTER the Ink shell has
  // unmounted (runConfig has returned) so the progress output owns the terminal
  // cleanly. A component-download failure NEVER fails init — exit 0, log the
  // fix, and let the component lazy-retry on first use.
  const print = (line: string): void => { process.stderr.write(`${line}\n`); };
  let components: ComponentSummary;
  if (flags.warmup) {
    const { autoReporter } = await import('./tui/reporter-auto.js');
    const reporter = autoReporter({ command: 'init' });
    const warmupResult = await runFullSetup(reporter, print);
    components = componentSummaryFromWarmup(warmupResult);
  } else {
    // Download-nothing escape hatch: every component lazy-loads on first use.
    print(PRECACHE_HINT);
    components = componentSummaryFromWarmup(null);
  }

  const doctor = await reportSetupAndDoctor(components, dataDir, print);

  if (flags.json) {
    emitInitJson({
      status: 'ok',
      path: 'wizard',
      warmup: flags.warmup,
      agentsRegistered: wizardAgents,
      configPersisted: true,
      components,
      doctor,
    });
  }
  return 0;
}

interface InitFlagsResolved {
  nonInteractive: boolean;
  agents: readonly string[];
  skipVerify: boolean;
  plain: boolean;
  help: boolean;
  wizard: boolean;
  warmup: boolean;
  json: boolean;
  provider?: string;
  search?: string;
}

async function runInitPlain(flags: InitFlagsResolved): Promise<number> {
  const { renderBanner } = await import('./tui/banner.js');
  const { getPackageVersion } = await import('./tui/version.js');
  const { runSystemCheck } = await import('./tui/system-check.js');
  const { ok, fail, warn, info } = await import('./tui/format.js');
  const { default: chalk } = await import('chalk');
  const { detectAgents } = await import('./tui/agents.js');
  const { applyConfigs } = await import('./tui/config-writer.js');
  const { autoReporter } = await import('./tui/reporter-auto.js');
  const { getConfig } = await import('../config.js');
  const { saveInitConfig } = await import('./tui/utils/config-writer.js');
  type AgentId = import('./tui/agents.js').AgentId;

  // Under --json, stdout is reserved for the single machine-readable summary
  // object; all human report lines route to stderr so JSON stays parseable.
  function out(line = ''): void {
    if (flags.json) process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  const version = getPackageVersion();
  if (flags.json) process.stderr.write(renderBanner(version));
  else process.stdout.write(renderBanner(version));

  const sysResult = await runSystemCheck();

  out(chalk.bold('  Checking your system...'));
  if (sysResult.node.ok) {
    out(`  ${ok(`Node.js ${sysResult.node.version}`)}`);
  } else {
    out(`  ${fail(`Node.js ${sysResult.node.version ?? '(unknown)'}`)}`);
    if (sysResult.node.message) out(`    ${chalk.gray(sysResult.node.message)}`);
  }
  if (sysResult.python.ok) {
    out(`  ${ok(`Python ${sysResult.python.version} (${sysResult.python.binary})`)}`);
  } else {
    out(`  ${fail('Python 3 not found')}`);
    if (sysResult.python.message) out(`    ${chalk.gray(sysResult.python.message)}`);
    out(`    ${chalk.gray('Install: https://python.org/downloads or `brew install python3`')}`);
  }
  if (sysResult.docker.ok) {
    out(`  ${ok(`Docker ${sysResult.docker.version ?? ''} ${chalk.gray('(optional)')}`)}`.trim());
  } else {
    out(`  ${warn(`Docker not found ${chalk.gray('(optional)')}`)}`);
  }
  if (sysResult.disk.ok) {
    out(`  ${ok(`Disk: ${sysResult.disk.freeMb} MB free`)}`);
  } else {
    out(`  ${warn(`Disk: ${sysResult.disk.message ?? 'low free space'}`)}`);
  }
  if (sysResult.hardFailure) {
    out();
    out(chalk.red.bold('  Setup cannot continue until the issues above are resolved.'));
    if (flags.json) {
      emitInitJson({ status: 'error', path: 'plain', warmup: false, agentsRegistered: [], configPersisted: false, message: 'system check hard failure' });
    }
    return 1;
  }
  out();
  out(`  ${info('System check passed.')}`);
  out();

  const print = (line: string): void => { process.stderr.write(`${line}\n`); };

  // Full setup (default): download every component up front so setup failures
  // surface loudly. `--no-warmup` skips ALL downloads — components then lazy-load
  // on first use. A component-download failure NEVER fails init (runFullSetup
  // swallows + logs the fix); agent wiring + config persist still proceed and
  // init exits 0. The per-component report + doctor summary are printed AFTER
  // wiring so the failure detail sits with the diagnostics at the end.
  let components: ComponentSummary;
  if (flags.warmup) {
    const reporter = autoReporter({ plain: flags.plain, command: 'init' });
    const warmupResult = await runFullSetup(reporter, print);
    components = componentSummaryFromWarmup(warmupResult);
  } else {
    // Download-nothing escape hatch: every component lazy-loads on first use.
    print(PRECACHE_HINT);
    components = componentSummaryFromWarmup(null);
  }

  let detected;
  try {
    detected = detectAgents({});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Agent detection failed: ${message}\n`);
    return 1;
  }

  let selected: AgentId[];
  if (flags.nonInteractive) {
    selected = [...flags.agents] as AgentId[];
  } else {
    const { selectAgents, NotTtyError } = await import('./tui/select-agents.js');
    try {
      selected = await selectAgents(detected);
    } catch (err) {
      if (err instanceof NotTtyError) {
        process.stderr.write('init requires an interactive terminal.\n');
        process.stderr.write('Use --non-interactive --agents=<comma-list> in scripts or CI.\n');
        return 2;
      }
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Selection failed: ${message}\n`);
      return 1;
    }
  }

  // In non-interactive mode an empty agent list is a valid choice: warmup above
  // has already set up the engine (on-device models, browser, cache), so we skip
  // agent wiring and let a user whose agent has no built-in installer point it at
  // wigolo's MCP server by hand. In interactive mode an empty selection means the
  // user picked nothing, so there is genuinely nothing left to do.
  if (selected.length === 0 && !flags.nonInteractive) {
    process.stderr.write('No agents selected — nothing to do.\n');
    return 0;
  }

  const config = getConfig();

  if (selected.length === 0) {
    out();
    out(`  ${info('Engine ready — no agent wiring requested.')}`);
    out(`  ${chalk.gray('Point your MCP client at:  npx wigolo mcp')}`);
  } else {
    try {
      await applyConfigs(detected, selected, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Writing configs failed: ${message}\n`);
      return 1;
    }

    // Install instructions and commands for agents that support them. Each step
    // has its own try/catch so a failure in one step does not cause the others
    // to be reported as "skipped". Skills are installed ONCE after this loop via
    // the shared skills engine, not per handler.
    const { getAgentHandler } = await import('./agents/registry.js');

    for (const id of selected) {
      const handler = getAgentHandler(id);
      if (!handler) continue;
      out(`  Configuring ${handler.displayName}...`);

      try {
        await handler.installInstructions();
        out(`  ${ok('Global instructions updated')}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        out(`  ${warn(`Instructions skipped: ${message}`)}`);
      }

      if (handler.supportsCommands && handler.installCommand) {
        try {
          await handler.installCommand();
          out(`  ${ok('Command installed')}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          out(`  ${warn(`Command skipped: ${message}`)}`);
        }
      }
    }

    // Skills — one engine call for every selected skills-capable agent at global
    // scope. Selected agents with no skills target (vscode/zed/antigravity/
    // opencode) are simply not in the engine's supported set and contribute
    // nothing; that is not an error.
    await installSelectedSkills(selected, out, ok, warn);
  }

  saveInitConfig(config.dataDir, {
    configuredAgents: selected,
    lastInit: new Date().toISOString(),
  });

  // Optional onboarding: pick search engine, RSS feeds, LLM endpoint.
  // Defaults are skip-everything, so non-interactive and "just hit Enter"
  // users land in exactly the prior behaviour.
  if (!flags.nonInteractive) {
    try {
      const { promptExtras } = await import('./tui/extras-prompt.js');
      await promptExtras(config.dataDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Optional setup skipped: ${message}\n`);
    }
  }

  // Persist provider/search selections and the LLM API key when supplied.
  // Provider/search are non-secret selects → applyHeadlessSet handles validation + fan-out.
  // The API key is a masked/secret field → applyHeadlessSet refuses it; use save() directly.
  if (flags.provider || flags.search || process.env.WIGOLO_LLM_API_KEY) {
    const { CATALOG } = await import('./tui/schema/catalog.js');
    const { defaultAgentTargets } = await import('./tui/state/agent-targets.js');
    const { defaultSecretStore } = await import('./tui/state/secret-store.js');
    const { defaultConfigPath } = await import('../persisted-config.js');
    const configPath = defaultConfigPath();
    const agentTargets = defaultAgentTargets({ dataDir: config.dataDir });
    const secretStore = defaultSecretStore({ dataDir: config.dataDir });

    if (flags.provider) {
      const { applyHeadlessSet } = await import('./tui/actions/index.js');
      const r = await applyHeadlessSet({ key: 'WIGOLO_LLM_PROVIDER', value: flags.provider, configPath, catalog: CATALOG, agents: agentTargets, secretStore });
      if (r.status !== 'ok') process.stderr.write(`Provider not set: ${r.message}\n`);
    }

    if (flags.search) {
      const { applyHeadlessSet } = await import('./tui/actions/index.js');
      const r = await applyHeadlessSet({ key: 'WIGOLO_SEARCH', value: flags.search, configPath, catalog: CATALOG, agents: agentTargets, secretStore });
      if (r.status !== 'ok') process.stderr.write(`Search backend not set: ${r.message}\n`);
    }

    const apiKey = process.env.WIGOLO_LLM_API_KEY;
    if (apiKey) {
      const { createSettingsStore } = await import('./tui/state/settings-store.js');
      const { readPersistedConfig } = await import('../persisted-config.js');
      const { save: runSave } = await import('./tui/state/propagation.js');
      const persistedSettings = readPersistedConfig(configPath).settings;
      const store = createSettingsStore(persistedSettings);
      store.set('llmApiKey', apiKey);
      const saveRes = await runSave({ store, catalog: CATALOG, configPath, agents: agentTargets, secretStore });
      if (saveRes.errors?.length) process.stderr.write(`LLM key save failed: ${saveRes.errors.map(e => e.reason).join('; ')}\n`);

      // The save() above persists the key in the TUI secret-store namespace,
      // which the runtime resolver (resolveProviderKey) never consults — it
      // reads the provider keystore (keychain `wigolo-<provider>` / encrypted
      // file). Without also writing there, a cold headless install leaves
      // research/agent disabled until the key is re-entered with the env var
      // present. Persist under the named provider so the key is usable at runtime.
      const providerName = flags.provider ?? persistedSettings['llmProvider'];
      if (typeof providerName === 'string' && (KEYSTORE_PROVIDERS as readonly string[]).includes(providerName)) {
        const { storeKey } = await import('../security/key-store.js');
        try {
          await storeKey(providerName as LLMProvider, apiKey, { dataDir: config.dataDir });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`LLM key keystore persist failed: ${message}\n`);
        }
      }
    }
  }

  // Autodetect a local LLM server and hint at the keyless lever. Runs after the
  // provider-persist block so an LLM just configured via --provider suppresses
  // the hint (no nag). Hint only — never auto-enabled; fail-safe if absent.
  await maybePrintOllamaHint((line) => out(`  ${line}`));

  const { probeSetupStatus, defaultProbeDeps, summarizeSetup } = await import('./tui/actions/setup-status.js');
  // Bust the in-process cache so the probe reads fresh from disk. Without this,
  // applyHeadlessSet / save() writes bypass the cache (atomicWriteJson direct fs
  // write), and the probe can return the stale backend written before this run.
  const { resetPersistedConfig } = await import('../persisted-config.js');
  resetPersistedConfig();
  // Engine-only mode = non-interactive with no `--agents` given. Registering no
  // agent is then a deliberate choice, not a setup failure. In interactive mode
  // the user always passes through the agent-selection step, so agents ARE
  // requested. `agentsRequested` decides whether an empty agent list fails setup.
  const agentsRequested = !(flags.nonInteractive && flags.agents.length === 0);
  const statuses = await probeSetupStatus(defaultProbeDeps(), { agentsRequested });
  const summary = summarizeSetup(statuses);
  out();
  for (const line of summary.lines) out(`  ${line}`);

  // Per-component setup report + doctor cold checks (presence/snapshot only, no
  // live network verify). A failed component download is reported here with its
  // fix but does NOT change the exit code — a missing/failed component is 'lazy'
  // in the honest probe (self-installs on first use), so it never sets
  // requiredFailed. The exit code stays driven by the honest setup summary: a
  // genuinely-failed REQUESTED agent registration is still an exit-1 failure.
  const doctor = await reportSetupAndDoctor(components, config.dataDir, print);

  if (flags.json) {
    emitInitJson({
      status: summary.exitCode === 0 ? 'ok' : 'error',
      path: 'plain',
      warmup: flags.warmup,
      agentsRegistered: [...selected],
      configPersisted: true,
      components,
      doctor,
      readyCount: summary.readyCount,
      total: summary.total,
      requiredFailed: summary.requiredFailed,
    });
  }
  return summary.exitCode;
}

