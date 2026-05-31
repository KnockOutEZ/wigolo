/**
 * Entry router for the schema-driven TUI shell.
 *
 * `resolveEntry()` reads the persisted config (via `readPersistedConfig`) when
 * `mode === 'auto'` to decide whether to launch the wizard or the settings
 * shell. This is NOT a pure function — tests that need isolation must use a
 * tmpdir, set `WIGOLO_CONFIG_PATH`, and call `resetPersistedConfig()` in
 * `afterEach` to bust the per-path cache.
 *
 * `runEntry()` is the side-effecting twin: calls `resolveEntry()` then
 * either mounts the new Ink shell (`InkRoot`) with the proper
 * initial view (SettingsHome or 4-step Wizard) or returns a headless code
 * path so the caller can fall back to its own plain renderer.
 *
 * The legacy `runInkInit` / `runInkConfig` entry points are deleted in this
 * slice; everything Ink-related now flows through here.
 */

import { stat } from 'node:fs/promises';
import { readPersistedConfig } from '../../persisted-config.js';
import { hasRequiredFields } from './state/required-fields.js';
import React from 'react';
import { render, useApp } from 'ink';
import type { CategoryDef } from './schema/types.js';
import type { SettingsStore } from './state/settings-store.js';
import type { ToastStore } from './state/toast-store.js';
import type { ActivityStore } from './state/activity-store.js';
import type { AgentTarget } from './state/agent-targets.js';
import type { SecretStore } from './state/propagation.js';
import { toastStore as defaultToastStore } from './state/toast-store-instance.js';
import { activityStore as defaultActivityStore } from './state/activity-store-instance.js';

export type EntryMode = 'wizard' | 'home' | 'auto';

export interface EntryResolution {
  /** Concrete mode selected. `auto` is always resolved to one of these. */
  mode: 'wizard' | 'home';
  /** True if the on-disk config file is missing (or the caller forced wizard). */
  firstRun: boolean;
  /**
   * True when Ink must NOT be mounted (no TTY / CI / --plain / --non-interactive).
   * The caller is responsible for emitting an equivalent plain-text experience.
   */
  headless: boolean;
}

export interface ResolveEntryOpts {
  mode: EntryMode;
  configPath: string;
  /** Defaults to `process.stdout.isTTY`. */
  isTTY?: boolean;
  /** Defaults to `process.env.CI === 'true' || '1' || process.env.GITHUB_ACTIONS === 'true'`. */
  ci?: boolean;
  /** Caller-passed `--non-interactive` / `-y` flag. */
  nonInteractive?: boolean;
  /** Caller-passed `--plain` / `-p` flag. */
  plain?: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

function defaultIsTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

function defaultCi(): boolean {
  return (
    process.env.CI === 'true' ||
    process.env.CI === '1' ||
    process.env.GITHUB_ACTIONS === 'true'
  );
}

export async function resolveEntry(opts: ResolveEntryOpts): Promise<EntryResolution> {
  const isTTY = opts.isTTY ?? defaultIsTTY();
  const ci = opts.ci ?? defaultCi();
  const nonInteractive = opts.nonInteractive ?? false;
  const plain = opts.plain ?? false;
  const headless = !isTTY || ci || nonInteractive || plain;

  const exists = await fileExists(opts.configPath);

  if (opts.mode === 'wizard') {
    return { mode: 'wizard', firstRun: !exists, headless };
  }
  if (opts.mode === 'home') {
    return { mode: 'home', firstRun: !exists, headless };
  }
  // auto — route to wizard when file is missing OR required fields are absent
  if (!exists) {
    return { mode: 'wizard', firstRun: true, headless };
  }
  const persisted = readPersistedConfig(opts.configPath);
  if (!hasRequiredFields(persisted)) {
    return { mode: 'wizard', firstRun: false, headless };
  }
  return { mode: 'home', firstRun: false, headless };
}

// ---------------------------------------------------------------------------
// runEntry — mounts Ink (or returns a headless decision to the caller)
// ---------------------------------------------------------------------------

export interface RunEntryOpts extends ResolveEntryOpts {
  /** Initial store hydrated with the on-disk config + defaults. */
  store: SettingsStore;
  /** Catalog used for schema-driven rendering. */
  catalog: ReadonlyArray<CategoryDef>;
  /** Optional product version for the SettingsHome header. */
  version?: string;
  /** Optional product name for the SettingsHome header. */
  productName?: string;
  /** Agents registry used for wizard step 4 (Agents). */
  agents?: ReadonlyArray<AgentTarget>;
  /** Secret store used by the wizard's save step. */
  secretStore?: SecretStore;
}

export interface RunEntryResult {
  resolution: EntryResolution;
  /** True when Ink was mounted and `waitUntilExit()` returned. */
  mounted: boolean;
}

interface MountRootProps {
  store: SettingsStore;
  catalog: ReadonlyArray<CategoryDef>;
  initialView: 'wizard' | 'home';
  version?: string;
  productName?: string;
  configPath: string;
  agents?: ReadonlyArray<AgentTarget>;
  secretStore?: SecretStore;
  /**
   * Test seam — inject pre-loaded components to bypass the lazy dynamic import.
   * Production callers never pass these; tests pass stubs to avoid I/O.
   */
  _inkRoot?: React.ComponentType<{
    store: SettingsStore;
    catalog: ReadonlyArray<CategoryDef>;
    onExit?: () => void;
    version?: string;
    productName?: string;
    toastStore?: ToastStore;
    activityStore?: ActivityStore;
  }>;
  _wizardSteps?: React.ComponentType<{
    store: SettingsStore;
    catalog: ReadonlyArray<CategoryDef>;
    configPath: string;
    agents?: ReadonlyArray<AgentTarget>;
    secretStore?: SecretStore;
    onDone: () => void;
    onSkip: () => void;
  }>;
}

/**
 * Inner wrapper that owns the unmount lifecycle via `useApp().exit()`. We
 * cannot rely on the router to call `useApp` because tests render it bare
 * and pass a noop `onExit`; centralising the unmount here keeps the router
 * agnostic of how it is hosted.
 */
export function MountRoot(props: MountRootProps): React.ReactElement {
  const { exit } = useApp();
  const [ShellRoot, setShellRoot] = React.useState<React.ComponentType<{
    store: SettingsStore;
    catalog: ReadonlyArray<CategoryDef>;
    onExit?: () => void;
    version?: string;
    productName?: string;
    toastStore?: ToastStore;
    activityStore?: ActivityStore;
  }> | null>(() => props._inkRoot ?? null);
  const [WizardSteps, setWizardSteps] = React.useState<React.ComponentType<{
    store: SettingsStore;
    catalog: ReadonlyArray<CategoryDef>;
    configPath: string;
    agents?: ReadonlyArray<AgentTarget>;
    secretStore?: SecretStore;
    onDone: () => void;
    onSkip: () => void;
  }> | null>(() => props._wizardSteps ?? null);
  const [phase, setPhase] = React.useState<'wizard' | 'home'>(props.initialView);

  // Sync phase when the parent passes a new initialView (e.g. init → force-wizard
  // delegate resolves after the component has already mounted with 'home').
  React.useEffect(() => {
    setPhase(props.initialView);
  }, [props.initialView]);

  React.useEffect(() => {
    // When stubs are injected (test seam), skip the lazy dynamic import entirely.
    if (props._inkRoot && props._wizardSteps) return;
    let cancelled = false;
    // Lazy-load both components so we don't pay their cost in headless mode.
    void (async () => {
      const [routerMod, wizardMod] = await Promise.all([
        import('./router/ink.js'),
        import('./components/WizardSteps.js'),
      ]);
      if (cancelled) return;
      setShellRoot(() => routerMod.InkRoot);
      setWizardSteps(() => wizardMod.WizardSteps);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ShellRoot || !WizardSteps) {
    // Brief loading frame before the lazy import resolves.
    return React.createElement(React.Fragment, null);
  }

  if (phase === 'wizard') {
    return React.createElement(WizardSteps, {
      store: props.store,
      catalog: props.catalog,
      configPath: props.configPath,
      agents: props.agents,
      secretStore: props.secretStore,
      onDone: () => setPhase('home'),
      onSkip: () => setPhase('home'),
    });
  }

  return React.createElement(ShellRoot, {
    store: props.store,
    catalog: props.catalog,
    onExit: () => exit(),
    version: props.version,
    productName: props.productName,
    toastStore: defaultToastStore,
    activityStore: defaultActivityStore,
  });
}

/**
 * Mounts the Ink shell with either the 4-step Wizard or SettingsHome.
 *
 * Headless callers (no TTY / CI / --plain / --non-interactive) get the
 * resolution back without any rendering so they can fall through to their
 * own plain-text flow. First-run headless is intentionally not implemented
 * here — slice 12 ships the full `--set` headless parity; until then,
 * callers print a "rerun in a terminal or use --plain" message and exit.
 */
export async function runEntry(opts: RunEntryOpts): Promise<RunEntryResult> {
  const resolution = await resolveEntry(opts);
  if (resolution.headless) {
    return { resolution, mounted: false };
  }

  const { waitUntilExit } = render(
    React.createElement(MountRoot, {
      store: opts.store,
      catalog: opts.catalog,
      initialView: resolution.mode,
      version: opts.version,
      productName: opts.productName,
      configPath: opts.configPath,
      agents: opts.agents,
      secretStore: opts.secretStore,
    }),
  );
  await waitUntilExit();
  return { resolution, mounted: true };
}
