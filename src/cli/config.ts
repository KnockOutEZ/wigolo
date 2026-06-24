/**
 * `wigolo config` / `wigolo dashboard` — reconfigure and management entry.
 *
 * In interactive TTY mode, mounts the Ink schema-driven shell in home mode.
 * In non-TTY / --plain / --non-interactive mode, prints a summary of current
 * settings and exits cleanly (headless parity requirement).
 *
 * Headless flags (non-interactive parity):
 *   --export [path]      Export config to file (default: ~/wigolo-config-export.json)
 *   --import <path>      Import config from file
 *   --cleanup <component> Cleanup a component (cache|embeddings|models|browser|searxng)
 *   --prune-audit --older-than <dur> --yes  Prune studio audit rows older than <dur> (fail-closed)
 *   --uninstall [--yes]  Full uninstall (requires --yes to skip confirmation)
 *   --storage            Print storage usage map
 *   --cache-stats        Print cache statistics
 *   --set key=value      Update a single non-secret setting (slice 12)
 *
 * HARD invariant: NEVER called from the MCP stdio path. Only mounted here,
 * from `init`, and from `doctor --interactive`.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getConfig } from '../config.js';
import type { CategoryDef, FieldDef } from './tui/schema/types.js';

const CONFIG_USAGE = [
  'Usage: wigolo config [options]',
  '',
  'Opens the interactive settings shell. On first run (or when required fields',
  'are missing), automatically launches the setup wizard.',
  '',
  'Options:',
  '  --force-wizard           Always launch the setup wizard (alias: wigolo init).',
  '                           Use the bare flag; --force-wizard=true is not accepted.',
  '  --plain, -p              Print current settings and exit (non-interactive)',
  '  --storage                Print storage usage map',
  '  --cache-stats            Print cache statistics',
  '  --export [path]          Export config to file (secrets excluded)',
  '  --import <path>          Import config from file',
  '  --cleanup <component>    Free storage for: cache|embeddings|models|browser|searxng',
  '  --prune-audit --older-than <dur> --yes  Prune studio audit rows older than <dur> (e.g. 30d)',
  '  --set <key>=<value>      Update a single non-secret setting headlessly',
  '  --uninstall              Full uninstall (requires --yes)',
  '  --yes                    Skip interactive confirmation (use with --uninstall)',
  '  --help, -h               Show this message',
  '',
].join('\n');

const CLEANABLE = new Set(['cache', 'embeddings', 'models', 'browser', 'searxng']);

interface ConfigFlags {
  plain: boolean;
  help: boolean;
  forceWizard: boolean;
  storage: boolean;
  cacheStats: boolean;
  export: string | null;  // path or null (use default when flag present, undefined when absent)
  exportRequested: boolean;
  import: string | null;
  cleanup: string | null;
  set: string | null;
  uninstall: boolean;
  yes: boolean;
  pruneAudit: boolean;
  olderThan: string | null;
}

/** Parse an `--older-than` duration (`30d`, `12h`, `45m`, `60s`, `2w`) to milliseconds. Returns null on garbage/empty/non-positive — the caller fails closed (no delete) on null. */
function parseDurationMs(raw: string): number | null {
  const m = /^(\d+)\s*([smhdw])$/.exec(raw.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * unit[m[2]];
}

function parseConfigFlags(args: string[]): ConfigFlags {
  const flags: ConfigFlags = {
    plain: false,
    help: false,
    forceWizard: false,
    storage: false,
    cacheStats: false,
    export: null,
    exportRequested: false,
    import: null,
    cleanup: null,
    set: null,
    uninstall: false,
    yes: false,
    pruneAudit: false,
    olderThan: null,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg) { i++; continue; }

    if (arg === '--plain' || arg === '-p') { flags.plain = true; i++; continue; }
    if (arg === '--help' || arg === '-h') { flags.help = true; i++; continue; }
    if (arg === '--force-wizard') { flags.forceWizard = true; i++; continue; }
    if (arg === '--storage') { flags.storage = true; i++; continue; }
    if (arg === '--cache-stats') { flags.cacheStats = true; i++; continue; }
    if (arg === '--yes' || arg === '-y') { flags.yes = true; i++; continue; }
    if (arg === '--uninstall') { flags.uninstall = true; i++; continue; }
    if (arg === '--prune-audit') { flags.pruneAudit = true; i++; continue; }

    if (arg === '--older-than') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags.olderThan = next;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (arg.startsWith('--older-than=')) {
      flags.olderThan = arg.slice('--older-than='.length) || null;
      i++;
      continue;
    }

    if (arg === '--export') {
      flags.exportRequested = true;
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags.export = next;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (arg.startsWith('--export=')) {
      flags.exportRequested = true;
      flags.export = arg.slice('--export='.length) || null;
      i++;
      continue;
    }

    if (arg === '--import') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        process.stderr.write('--import requires a path argument\n');
        process.exit(1);
      }
      flags.import = next;
      i += 2;
      continue;
    }
    if (arg.startsWith('--import=')) {
      flags.import = arg.slice('--import='.length);
      i++;
      continue;
    }

    if (arg === '--cleanup') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        process.stderr.write(`--cleanup requires a component: ${[...CLEANABLE].join('|')}\n`);
        process.exit(1);
      }
      flags.cleanup = next;
      i += 2;
      continue;
    }
    if (arg.startsWith('--cleanup=')) {
      flags.cleanup = arg.slice('--cleanup='.length);
      i++;
      continue;
    }

    if (arg === '--set') {
      const next = args[i + 1];
      if (!next || next.startsWith('-') || !next.includes('=')) {
        process.stderr.write('--set requires <key>=<value> (e.g. --set WIGOLO_SEARCH=hybrid)\n');
        process.exit(1);
      }
      flags.set = next;
      i += 2;
      continue;
    }
    if (arg.startsWith('--set=')) {
      const payload = arg.slice('--set='.length);
      if (!payload.includes('=')) {
        process.stderr.write('--set requires <key>=<value> (e.g. --set=WIGOLO_SEARCH=hybrid)\n');
        process.exit(1);
      }
      flags.set = payload;
      i++;
      continue;
    }

    // unknown flag — ignore (forward-compat)
    i++;
  }

  return flags;
}

export async function runConfig(args: string[]): Promise<number> {
  const flags = parseConfigFlags(args);

  if (flags.help) {
    process.stderr.write(CONFIG_USAGE);
    return 0;
  }

  // ----- Headless actions -----

  if (flags.storage) {
    const { computeStorage } = await import('./tui/actions/index.js');
    const config = getConfig();
    const result = await computeStorage(config.dataDir);
    process.stdout.write('Storage usage\n');
    process.stdout.write('=============\n');
    for (const item of result.items) {
      const mb = (item.bytes / (1024 * 1024)).toFixed(2);
      process.stdout.write(`  ${item.label.padEnd(24)} ${mb} MB\n`);
    }
    process.stdout.write(`\n  ${'Total'.padEnd(24)} ${(result.totalBytes / (1024 * 1024)).toFixed(2)} MB\n`);
    return 0;
  }

  if (flags.cacheStats) {
    const { getCacheStatsAction } = await import('./tui/actions/index.js');
    const stats = await getCacheStatsAction();
    if (stats.error) {
      process.stderr.write(`Cache stats error: ${stats.error}\n`);
      return 1;
    }
    process.stdout.write('Cache statistics\n');
    process.stdout.write('================\n');
    process.stdout.write(`  Entries: ${stats.totalEntries}\n`);
    process.stdout.write(`  Size:    ${stats.sizeMb.toFixed(2)} MB\n`);
    if (stats.oldest) process.stdout.write(`  Oldest:  ${stats.oldest}\n`);
    if (stats.newest) process.stdout.write(`  Newest:  ${stats.newest}\n`);
    return 0;
  }

  if (flags.exportRequested) {
    const { exportConfig } = await import('./tui/actions/index.js');
    const defaultPath = join(homedir(), 'wigolo-config-export.json');
    const exportPath = flags.export ?? defaultPath;
    const configPath = process.env.WIGOLO_CONFIG_PATH ?? join(homedir(), '.wigolo', 'config.json');
    const result = await exportConfig(exportPath, configPath);
    if (result.ok) {
      process.stdout.write(`Config exported to ${exportPath} (secrets excluded)\n`);
      return 0;
    }
    process.stderr.write(`Export failed: ${result.error}\n`);
    return 1;
  }

  if (flags.import !== null) {
    const { importConfig } = await import('./tui/actions/index.js');
    const configPath = process.env.WIGOLO_CONFIG_PATH ?? join(homedir(), '.wigolo', 'config.json');
    const result = await importConfig(flags.import, configPath);
    if (result.ok) {
      process.stdout.write(`Config imported from ${flags.import}\n`);
      return 0;
    }
    process.stderr.write(`Import failed: ${result.error}\n`);
    return 1;
  }

  if (flags.cleanup !== null) {
    const component = flags.cleanup;
    if (!CLEANABLE.has(component)) {
      process.stderr.write(`Unknown component: ${component}. Valid: ${[...CLEANABLE].join(', ')}\n`);
      return 1;
    }
    const { cleanupComponent } = await import('./tui/actions/index.js');
    const config = getConfig();
    const result = await cleanupComponent(
      component as 'cache' | 'embeddings' | 'models' | 'browser' | 'searxng',
      config.dataDir,
    );
    if (result.ok) {
      const mb = (result.freedBytes / (1024 * 1024)).toFixed(2);
      process.stdout.write(`Cleaned ${component}: freed ${mb} MB\n`);
      return 0;
    }
    process.stderr.write(`Cleanup failed: ${result.error}\n`);
    return 1;
  }

  if (flags.pruneAudit) {
    // Operator-only prune of the studio audit forensic log. Fail-closed: require an explicit
    // by-age cutoff AND a typed confirmation before ANY row is deleted (a forensic log — stricter
    // than --cleanup, which has no confirm). Never default a missing/garbage cutoff to delete-all.
    if (!flags.olderThan) {
      process.stderr.write('--prune-audit requires --older-than <duration> (e.g. 30d, 12h). No rows deleted.\n');
      return 1;
    }
    const durationMs = parseDurationMs(flags.olderThan);
    if (durationMs === null) {
      process.stderr.write(`Invalid --older-than duration: ${flags.olderThan}. Use e.g. 30d, 12h, 45m, 60s, 2w. No rows deleted.\n`);
      return 1;
    }
    if (!flags.yes) {
      process.stderr.write('Pruning the audit log is irreversible. Re-run with --yes to confirm. No rows deleted.\n');
      return 1;
    }
    const { getDatabase } = await import('../cache/db.js');
    const { pruneStudioAudit } = await import('../studio/audit-retention.js');
    let db: ReturnType<typeof getDatabase>;
    try {
      db = getDatabase();
    } catch {
      process.stderr.write('No database initialized — nothing to prune.\n');
      return 1;
    }
    const cutoffMs = Date.now() - durationMs;
    const { deleted } = pruneStudioAudit(db, { cutoffMs });
    process.stdout.write(`Pruned ${deleted} studio audit row(s) older than ${flags.olderThan}.\n`);
    return 0;
  }

  if (flags.set !== null) {
    const eqIdx = flags.set.indexOf('=');
    const key = flags.set.slice(0, eqIdx);
    const value = flags.set.slice(eqIdx + 1);
    const { applyHeadlessSet } = await import('./tui/actions/index.js');
    const { CATALOG } = await import('./tui/schema/catalog.js');
    const { defaultAgentTargets } = await import('./tui/state/agent-targets.js');
    const { defaultSecretStore } = await import('./tui/state/secret-store.js');
    const config = getConfig();
    const configPath = process.env.WIGOLO_CONFIG_PATH ?? join(homedir(), '.wigolo', 'config.json');
    const agents = defaultAgentTargets({ dataDir: config.dataDir });
    const secretStore = defaultSecretStore({ dataDir: config.dataDir });
    const result = await applyHeadlessSet({
      key,
      value,
      configPath,
      catalog: CATALOG,
      agents,
      secretStore,
    });
    if (result.status === 'ok') {
      process.stdout.write(`${result.message}\n`);
      return 0;
    }
    process.stderr.write(`${result.message}\n`);
    return 1;
  }

  if (flags.uninstall) {
    if (!flags.yes) {
      process.stderr.write(
        'Uninstall requires confirmation. Use --uninstall --yes to proceed.\n',
      );
      return 1;
    }
    const { uninstall } = await import('./tui/actions/index.js');
    const config = getConfig();
    const result = await uninstall({ dataDir: config.dataDir, confirmed: true });
    if (result.dataDirRemoved) {
      process.stdout.write(`Removed data directory: ${config.dataDir}\n`);
    }
    for (const ar of result.agentResults) {
      if (ar.error) {
        process.stderr.write(`${ar.displayName}: error — ${ar.error}\n`);
      } else if (ar.removed.length > 0) {
        process.stdout.write(`${ar.displayName}: removed ${ar.removed.join(', ')}\n`);
      }
    }
    if (!result.ok) {
      process.stderr.write(`Uninstall error: ${result.error}\n`);
      return 1;
    }
    process.stdout.write('Wigolo uninstalled.\n');
    return 0;
  }

  // ----- Interactive / plain mode -----

  const isTTY = Boolean(process.stdout.isTTY);
  const isCI =
    process.env.CI === 'true' ||
    process.env.CI === '1' ||
    process.env.GITHUB_ACTIONS === 'true';

  const useInk = !flags.plain && isTTY && !isCI;

  if (useInk) {
    return runInkConfig({
      isTTY,
      ci: isCI,
      plain: flags.plain,
      forceWizard: flags.forceWizard,
    });
  }

  // Plain / non-interactive: print current settings from the schema CATALOG.
  // The catalog + persisted-config accessor stay the source of truth — no
  // separate curated-env-vars list exists post-slice 12.
  const { CATALOG } = await import('./tui/schema/catalog.js');
  const { readPersistedConfig } = await import('../persisted-config.js');
  const config = getConfig();
  const configPath = process.env.WIGOLO_CONFIG_PATH ?? join(homedir(), '.wigolo', 'config.json');
  const persisted = readPersistedConfig(configPath);

  process.stdout.write('Wigolo current settings\n');
  process.stdout.write('=======================\n\n');

  for (const category of CATALOG) {
    printCategory(category, persisted.settings);
  }

  process.stdout.write(`\nData directory: ${config.dataDir}\n`);
  process.stdout.write('\nRun `wigolo config` in an interactive terminal to change settings.\n');
  process.stdout.write('\nHeadless commands:\n');
  process.stdout.write('  wigolo config --storage          Show storage usage\n');
  process.stdout.write('  wigolo config --cache-stats      Show cache statistics\n');
  process.stdout.write('  wigolo config --export           Export settings to file\n');
  process.stdout.write('  wigolo config --import <path>    Import settings from file\n');
  process.stdout.write('  wigolo config --cleanup <comp>   Free storage per component\n');
  process.stdout.write('  wigolo config --prune-audit --older-than <dur> --yes  Prune aged studio audit rows\n');
  process.stdout.write('  wigolo config --set k=v          Update a single non-secret setting\n');
  process.stdout.write('  wigolo config --uninstall --yes  Full uninstall\n');

  return 0;
}

/**
 * Format one FieldDef as a one-line summary. Masked/secret fields show only a
 * placeholder so a `--plain` print never leaks a credential.
 */
function formatFieldValue(field: FieldDef, raw: unknown): string {
  if (field.kind === 'masked' || field.secret === true) {
    return raw === undefined || raw === '' ? '(unset)' : '****';
  }
  if (raw === undefined || raw === null) {
    return field.default === undefined ? '(unset)' : `${String(field.default)} (default)`;
  }
  if (Array.isArray(raw)) return raw.join(', ');
  return String(raw);
}

function printCategory(
  category: CategoryDef,
  settings: Readonly<Record<string, unknown>>,
): void {
  process.stdout.write(`[${category.label}]\n`);
  for (const field of category.fields) {
    if (field.kind === 'readonly') continue;
    const raw = settings[field.settingsPath];
    const display = formatFieldValue(field, raw);
    // 30-col label keeps long key names from breaking alignment.
    process.stdout.write(`  ${field.key.padEnd(30)} ${display}\n`);
  }
  process.stdout.write('\n');
}

interface RunInkConfigOpts {
  isTTY: boolean;
  ci: boolean;
  plain: boolean;
  /** When true, always launch the wizard regardless of config state. */
  forceWizard?: boolean;
}

/**
 * Mounts the new schema-driven TUI.
 *
 * Entry routing:
 *   - forceWizard=true  → mode='wizard' (bypasses required-fields check)
 *   - forceWizard=false → mode='auto'   (wizard if config missing or incomplete,
 *                                        home if config has required fields)
 *
 * After wizard finish, the user drops directly into the settings shell with
 * the new config loaded — there is no intermediate state or "rerun" prompt.
 */
async function runInkConfig(opts: RunInkConfigOpts): Promise<number> {
  const { runEntry } = await import('./tui/entry.js');
  const { createSettingsStore } = await import('./tui/state/settings-store.js');
  const { CATALOG } = await import('./tui/schema/catalog.js');
  const { defaultAgentTargets } = await import('./tui/state/agent-targets.js');
  const { defaultSecretStore } = await import('./tui/state/secret-store.js');
  const { enableTuiMode } = await import('./tui/utils/suppress-logs.js');
  const { getPackageVersion } = await import('./tui/version.js');
  const { defaultConfigPath, readPersistedConfig } = await import('../persisted-config.js');
  const { toastStore } = await import('./tui/state/toast-store-instance.js');
  const { activityStore } = await import('./tui/state/activity-store-instance.js');

  enableTuiMode();
  const configPath = defaultConfigPath();
  const persisted = readPersistedConfig(configPath);
  const store = createSettingsStore(persisted.settings, toastStore, activityStore);
  const config = getConfig();
  const agents = defaultAgentTargets({ dataDir: config.dataDir });
  const secretStore = defaultSecretStore({ dataDir: config.dataDir });

  const result = await runEntry({
    mode: opts.forceWizard ? 'wizard' : 'auto',
    configPath,
    isTTY: opts.isTTY,
    ci: opts.ci,
    plain: opts.plain,
    store,
    catalog: CATALOG,
    agents,
    secretStore,
    version: getPackageVersion(),
    productName: 'wigolo',
  });

  if (!result.mounted) {
    // Headless gating tripped — caller already guarded on flags, but surface
    // a sensible non-zero so scripts notice if the gating ever drifts.
    process.stderr.write('Interactive config requires a terminal. Use --plain to see settings.\n');
    return 1;
  }
  return 0;
}
