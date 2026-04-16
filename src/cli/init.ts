import { renderBanner } from './tui/banner.js';
import { getPackageVersion } from './tui/version.js';
import { runSystemCheck, type SystemCheckResult } from './tui/system-check.js';
import { ok, fail, warn, info } from './tui/format.js';
import chalk from 'chalk';
import { parseInitFlags, FlagParseError } from './tui/flags.js';
import { runWarmup } from './warmup.js';
import { detectAgents } from './tui/agents.js';
import type { AgentId } from './tui/agents.js';
import { selectAgents, NotTtyError } from './tui/select-agents.js';
import { applyConfigs } from './tui/config-writer.js';
import { runVerify } from './tui/verify.js';
import { autoReporter } from './tui/reporter-auto.js';
import { getConfig } from '../config.js';

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

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function renderSystemCheck(result: SystemCheckResult): void {
  out(chalk.bold('  Checking your system...'));

  if (result.node.ok) {
    out(`  ${ok(`Node.js ${result.node.version}`)}`);
  } else {
    out(`  ${fail(`Node.js ${result.node.version ?? '(unknown)'}`)}`);
    if (result.node.message) out(`    ${chalk.gray(result.node.message)}`);
  }

  if (result.python.ok) {
    out(`  ${ok(`Python ${result.python.version} (${result.python.binary})`)}`);
  } else {
    out(`  ${fail('Python 3 not found')}`);
    if (result.python.message) out(`    ${chalk.gray(result.python.message)}`);
    out(`    ${chalk.gray('Install: https://python.org/downloads or `brew install python3`')}`);
  }

  if (result.docker.ok) {
    const ver = result.docker.version ?? '';
    out(`  ${ok(`Docker ${ver} ${chalk.gray('(optional, available)')}`.trim())}`);
  } else {
    out(`  ${warn(`Docker not found ${chalk.gray('(optional — only needed for docker-mode SearXNG)')}`)}`);
  }

  if (result.disk.ok) {
    out(`  ${ok(`Disk: ${result.disk.freeMb} MB free`)}`);
  } else {
    out(`  ${warn(`Disk: ${result.disk.message ?? 'low free space'}`)}`);
  }
}

function renderHardFailure(): void {
  out();
  out(chalk.red.bold('  Setup cannot continue until the issues above are resolved.'));
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

  if (flags.nonInteractive && flags.agents.length === 0) {
    process.stderr.write('--non-interactive requires --agents=<csv>\n');
    process.stderr.write(INIT_USAGE);
    return 2;
  }

  const version = getPackageVersion();
  process.stdout.write(renderBanner(version));

  const sysResult = await runSystemCheck();
  renderSystemCheck(sysResult);
  if (sysResult.hardFailure) {
    renderHardFailure();
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
