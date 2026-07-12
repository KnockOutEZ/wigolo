import { parseInitFlags, FlagParseError } from './tui/flags.js';
import type { LLMProvider } from '../integrations/cloud/llm/types.js';
import { probeOllama, resolveProbeBaseUrl, maybeOllamaHint } from './ollama-probe.js';

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

const INIT_USAGE = [
  'Usage: wigolo init [options]',
  '',
  'Alias for: wigolo config --force-wizard',
  'Always launches the interactive setup wizard, then drops into the settings shell.',
  '',
  'Options:',
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
  const useInk = !flags.plain && !flags.nonInteractive && isTTY && !isCI;

  if (useInk) {
    // Surface the keyless local-LLM lever before the wizard takes over the
    // terminal, so a user with a running Ollama server learns they can pick it
    // in the upcoming LLM step. Hint only — never auto-enabled.
    await maybePrintOllamaHint((line) => process.stderr.write(`${line}\n`));

    // Delegate to runConfig with --force-wizard: same code path, no divergent logic.
    // Don't forward --plain: this code path is reached only when useInk is true,
    // which already requires !flags.plain.
    const { runConfig } = await import('./config.js');
    const configArgs = ['--force-wizard'];
    const code = await runConfig(configArgs);
    if (code !== 0) return code;

    // If the user navigated to the uninstall screen and wiped wigolo mid-session,
    // skip warmup entirely — reinstalling components after an intentional uninstall
    // would recreate ~/.wigolo against the user's wishes.
    const { wasUninstalled } = await import('./tui/state/uninstall-signal.js');
    if (wasUninstalled()) return 0;

    // Parity with the non-interactive path: the Ink wizard configures agents and
    // settings but installs no tools. Run the full warmup AFTER the Ink shell has
    // unmounted (runConfig has returned) so warmup's own progress output owns the
    // terminal cleanly rather than fighting the live Ink render. Same flag set
    // (`--all`) as runInitPlain, so both paths leave wigolo fully set up.
    const { runWarmup } = await import('./warmup.js');
    const { autoReporter } = await import('./tui/reporter-auto.js');
    const reporter = autoReporter({ command: 'init' });
    try {
      await runWarmup(['--all'], reporter);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Warmup failed: ${message}\n`);
      return 1;
    }
    return 0;
  }

  // Plain / non-interactive mode — use the existing text-based flow
  return runInitPlain(flags);
}

interface InitFlagsResolved {
  nonInteractive: boolean;
  agents: readonly string[];
  skipVerify: boolean;
  plain: boolean;
  help: boolean;
  provider?: string;
  search?: string;
}

async function runInitPlain(flags: InitFlagsResolved): Promise<number> {
  const { renderBanner } = await import('./tui/banner.js');
  const { getPackageVersion } = await import('./tui/version.js');
  const { runSystemCheck } = await import('./tui/system-check.js');
  const { ok, fail, warn, info } = await import('./tui/format.js');
  const { default: chalk } = await import('chalk');
  const { runWarmup } = await import('./warmup.js');
  const { detectAgents } = await import('./tui/agents.js');
  const { applyConfigs } = await import('./tui/config-writer.js');
  const { runVerify } = await import('./tui/verify.js');
  const { autoReporter } = await import('./tui/reporter-auto.js');
  const { getConfig } = await import('../config.js');
  const { saveInitConfig } = await import('./tui/utils/config-writer.js');
  type AgentId = import('./tui/agents.js').AgentId;

  function out(line = ''): void {
    process.stdout.write(`${line}\n`);
  }

  const version = getPackageVersion();
  process.stdout.write(renderBanner(version));

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
    return 1;
  }
  out();
  out(`  ${info('System check passed.')}`);
  out();

  const reporter = autoReporter({ plain: flags.plain, command: 'init' });

  try {
    await runWarmup(['--all'], reporter);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warmup failed: ${message}\n`);
    return 1;
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

    // Install instructions, skills, and commands for agents that support them.
    // Each step has its own try/catch so a failure in one step does not cause
    // the others to be reported as "skipped".
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

      if (handler.supportsSkills && handler.installSkills) {
        try {
          await handler.installSkills();
          out(`  ${ok('8 skills installed')}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          out(`  ${warn(`Skills skipped: ${message}`)}`);
        }
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

  if (!flags.skipVerify) {
    try {
      const verifyResult = await runVerify(config.dataDir, reporter);
      if (!verifyResult.allPassed) {
        reporter.note('Some checks failed. The CLI will still continue.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Verify failed: ${message}\n`);
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
  const statuses = await probeSetupStatus(defaultProbeDeps());
  const summary = summarizeSetup(statuses);
  out();
  for (const line of summary.lines) out(`  ${line}`);
  return summary.exitCode;
}

