/**
 * Entry router for the schema-driven TUI shell.
 *
 * `resolveEntry()` is a pure decision function: given a caller's intent
 * (`wizard` | `home` | `auto`) and the runtime environment (TTY presence,
 * CI flag, `--plain` / `--non-interactive` overrides, on-disk config), it
 * picks one of two mountable modes plus a `firstRun` and `headless` flag.
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
import React from 'react';
import { render, useApp } from 'ink';
import type { CategoryDef } from './schema/types.js';
import type { SettingsStore } from './state/settings-store.js';
import type { AgentTarget } from './state/agent-targets.js';
import type { SecretStore } from './state/propagation.js';

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
  // auto
  return exists
    ? { mode: 'home', firstRun: false, headless }
    : { mode: 'wizard', firstRun: true, headless };
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
}

/**
 * Inner wrapper that owns the unmount lifecycle via `useApp().exit()`. We
 * cannot rely on the router to call `useApp` because tests render it bare
 * and pass a noop `onExit`; centralising the unmount here keeps the router
 * agnostic of how it is hosted.
 */
function MountRoot(props: MountRootProps): React.ReactElement {
  const { exit } = useApp();
  const [ShellRoot, setShellRoot] = React.useState<React.ComponentType<{
    store: SettingsStore;
    catalog: ReadonlyArray<CategoryDef>;
    onExit?: () => void;
    version?: string;
    productName?: string;
  }> | null>(null);
  const [WizardSteps, setWizardSteps] = React.useState<React.ComponentType<{
    store: SettingsStore;
    catalog: ReadonlyArray<CategoryDef>;
    configPath: string;
    agents?: ReadonlyArray<AgentTarget>;
    secretStore?: SecretStore;
    onDone: () => void;
    onSkip: () => void;
  }> | null>(null);
  const [phase, setPhase] = React.useState<'wizard' | 'home'>(props.initialView);

  React.useEffect(() => {
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
