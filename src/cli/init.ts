import { renderBanner } from './tui/banner.js';
import { getPackageVersion } from './tui/version.js';
import { runSystemCheck, type SystemCheckResult } from './tui/system-check.js';
import { ok, fail, warn, info } from './tui/format.js';
import chalk from 'chalk';

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

function renderNextSteps(result: SystemCheckResult): void {
  out();
  if (result.hardFailure) {
    out(chalk.red.bold('  Setup cannot continue until the issues above are resolved.'));
    return;
  }
  out(chalk.bold('  System check passed.'));
  out();
  out(`  ${info('Next: run `npx @staticn0va/wigolo warmup --all` to install dependencies.')}`);
  out(`  ${chalk.gray('(D2+ slices will replace this hint with an interactive installer.)')}`);
}

export async function runInit(_args: string[]): Promise<number> {
  const version = getPackageVersion();
  process.stdout.write(renderBanner(version));

  const result = await runSystemCheck();
  renderSystemCheck(result);
  renderNextSteps(result);

  return result.hardFailure ? 1 : 0;
}
