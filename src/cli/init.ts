import { parseInitFlags, FlagParseError } from './tui/flags.js';

const INIT_USAGE = [
  'Usage: wigolo init [options]',
  '',
  'Options:',
  '  --non-interactive, -y   Skip interactive prompts',
  '  --agents=<csv>          Comma-separated agent ids (required with --non-interactive)',
  '  --skip-verify           Skip the post-install verify step',
  '  --plain                 Force plain (non-TUI) output',
  '  --help, -h              Show this message',
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
    const { runInkInit } = await import('./tui/ink-init.js');
    await runInkInit();
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

  // Install instructions, skills, and commands for agents that support them
  {
    const { getAgentHandler } = await import('./agents/registry.js');
    for (const id of selected) {
      const handler = getAgentHandler(id);
      if (!handler) continue;
      try {
        out(`  Configuring ${handler.displayName}...`);
        await handler.installInstructions();
        out(`  ${ok('Global instructions updated')}`);
        if (handler.supportsSkills && handler.installSkills) {
          await handler.installSkills();
          out(`  ${ok('8 skills installed')}`);
        }
        if (handler.supportsCommands && handler.installCommand) {
          await handler.installCommand();
          out(`  ${ok('Command installed')}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        out(`  ${warn(`Skills/instructions skipped: ${message}`)}`);
      }
    }
  }

  saveInitConfig(config.dataDir, {
    configuredAgents: selected,
    lastInit: new Date().toISOString(),
  });

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

  return 0;
}
