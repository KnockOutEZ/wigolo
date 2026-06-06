import { parseInitFlags, FlagParseError } from './tui/flags.js';

const INIT_USAGE = [
  'Usage: wigolo init [options]',
  '',
  'Alias for: wigolo config --force-wizard',
  'Always launches the interactive setup wizard, then drops into the settings shell.',
  '',
  'Options:',
  '  --non-interactive, -y   Skip interactive prompts (uses plain text flow)',
  '  --agents=<csv>          Comma-separated agent ids (required with --non-interactive)',
  '  --skip-verify           Skip the post-install verify step',
  '  --plain                 Force plain (non-TUI) output',
  '  --provider=<name>       LLM provider for research/agent: anthropic|openai|gemini',
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

  if (flags.nonInteractive && flags.agents.length === 0) {
    process.stderr.write('--non-interactive requires --agents=<csv>\n');
    process.stderr.write(INIT_USAGE);
    return 2;
  }

  const isTTY = Boolean(process.stdout.isTTY);
  const isCI =
    process.env.CI === 'true' ||
    process.env.CI === '1' ||
    process.env.GITHUB_ACTIONS === 'true';
  const useInk = !flags.plain && !flags.nonInteractive && isTTY && !isCI;

  if (useInk) {
    // Delegate to runConfig with --force-wizard: same code path, no divergent logic.
    // Don't forward --plain: this code path is reached only when useInk is true,
    // which already requires !flags.plain.
    const { runConfig } = await import('./config.js');
    const configArgs = ['--force-wizard'];
    return runConfig(configArgs);
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

  if (selected.length === 0) {
    process.stderr.write('No agents selected — nothing to do.\n');
    return 0;
  }

  const config = getConfig();
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
  {
    const { getAgentHandler } = await import('./agents/registry.js');
    const { detectFirecrawlSkills } = await import('./agents/utils.js');
    const { homedir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');

    if (selected.includes('claude-code' as AgentId)) {
      const firecrawl = detectFirecrawlSkills(pathJoin(homedir(), '.claude', 'skills'));
      if (firecrawl.length > 0) {
        out();
        out(`  ${info(`Detected firecrawl skills (${firecrawl.join(', ')}).`)}`);
        out(`    ${chalk.gray('Wigolo will be preferred for local/cached/transparent searches.')}`);
        out(`    ${chalk.gray('See ~/.claude/skills/wigolo-search/SKILL.md for the boundaries.')}`);
      }
    }

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
      const store = createSettingsStore(readPersistedConfig(configPath).settings);
      store.set('llmApiKey', apiKey);
      const saveRes = await runSave({ store, catalog: CATALOG, configPath, agents: agentTargets, secretStore });
      if (saveRes.errors?.length) process.stderr.write(`LLM key save failed: ${saveRes.errors.map(e => e.reason).join('; ')}\n`);
    }
  }

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

