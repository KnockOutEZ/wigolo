/**
 * `wigolo config` / `wigolo dashboard` — reconfigure and management entry.
 *
 * In interactive TTY mode, mounts the Ink main-menu router (runInkConfig).
 * In non-TTY / --plain / --non-interactive mode, prints a summary of current
 * settings and exits cleanly (headless parity requirement §8).
 *
 * HARD invariant: NEVER called from the MCP stdio path. Only mounted here,
 * from `init`, and from `doctor --interactive`.
 */
import { readEnvSettings, CURATED_ENV_VARS, ENV_GROUP_LABELS } from './tui/actions/index.js';
import { getConfig } from '../config.js';

const CONFIG_USAGE = [
  'Usage: wigolo config [options]',
  '',
  'Opens the interactive reconfiguration menu.',
  '',
  'Options:',
  '  --plain, -p   Print current settings and exit (non-interactive)',
  '  --help, -h    Show this message',
  '',
].join('\n');

interface ConfigFlags {
  plain: boolean;
  help: boolean;
}

function parseConfigFlags(args: string[]): ConfigFlags {
  const flags: ConfigFlags = { plain: false, help: false };
  for (const arg of args) {
    if (arg === '--plain' || arg === '-p') flags.plain = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
  }
  return flags;
}

export async function runConfig(args: string[]): Promise<number> {
  const flags = parseConfigFlags(args);

  if (flags.help) {
    process.stderr.write(CONFIG_USAGE);
    return 0;
  }

  const isTTY = Boolean(process.stdout.isTTY);
  const isCI =
    process.env.CI === 'true' ||
    process.env.CI === '1' ||
    process.env.GITHUB_ACTIONS === 'true';

  const useInk = !flags.plain && isTTY && !isCI;

  if (useInk) {
    const { runInkConfig } = await import('./tui/router/ink-config.js');
    await runInkConfig();
    return 0;
  }

  // Plain / non-interactive: print current settings
  const config = getConfig();
  const settings = readEnvSettings();

  process.stdout.write('Wigolo current settings\n');
  process.stdout.write('=======================\n\n');

  const groupsSeen = new Set<string>();
  for (const meta of CURATED_ENV_VARS) {
    if (!groupsSeen.has(meta.group)) {
      groupsSeen.add(meta.group);
      process.stdout.write(`[${ENV_GROUP_LABELS[meta.group]}]\n`);
    }
    const val = settings[meta.settingsKey] ?? meta.defaultValue;
    const isDefault = val === meta.defaultValue;
    process.stdout.write(
      `  ${meta.label.padEnd(30)} ${val}${isDefault ? ' (default)' : ''}\n`,
    );
  }

  process.stdout.write(`\nData directory: ${config.dataDir}\n`);
  process.stdout.write('\nRun `wigolo config` in an interactive terminal to change settings.\n');

  return 0;
}
