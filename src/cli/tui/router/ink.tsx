/**
 * InkRoot — production entry (named export). Wraps the router in the App shell
 * (Header / Sidebar / Footer). entry.ts renders WizardSteps directly when
 * phase === 'wizard'; all post-wizard navigation flows through InkRoot.
 *
 * InkRouter (default export) is the legacy unwrapped router retained for
 * backwards-compat with SP6-era unit tests. It is NOT used in production.
 * See the @deprecated JSDoc on InkRouter for removal timeline.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useInput } from 'ink';
import type { CategoryDef, CategoryId } from '../schema/types.js';
import type { SettingsStore } from '../state/settings-store.js';
import type { ToastStore } from '../state/toast-store.js';
import { SettingsHome, type SettingsHomeAction } from '../components/SettingsHome.js';
import { CategoryScreen } from '../components/CategoryScreen.js';
import { VerifyScreen } from '../components/VerifyScreen.js';
import { DoctorScreen } from '../components/DoctorScreen.js';
import { DashboardExport } from '../components/DashboardExport.js';
import { ImportScreen } from '../components/ImportScreen.js';
import { DashboardUninstall } from '../components/DashboardUninstall.js';
import { App, DEFAULT_ROUTES } from '../shell/App.js';
import { buildPaletteIndex, type PaletteEntry } from '../shell/palette-index.js';

type ScreenView =
  | { kind: 'home' }
  | { kind: 'category'; id: CategoryId; initialFocusKey?: string }
  | { kind: 'action'; id: SettingsHomeAction };

const ACTION_LABELS = ['Verify', 'Doctor', 'Export', 'Import', 'Uninstall'];

export interface InkRouterProps {
  store: SettingsStore;
  catalog: ReadonlyArray<CategoryDef>;
  onExit: () => void;
  version?: string;
  productName?: string;
}

/**
 * @deprecated Retained for SP6-era unit tests; will be removed in SP10 cleanup.
 * Production code path uses the named export {@link InkRoot} which wraps screens in the shell.
 */
export default function InkRouter(props: InkRouterProps): React.ReactElement {
  const { store, catalog, onExit, version, productName } = props;

  const [view, setView] = useState<ScreenView>({ kind: 'home' });

  const goHome = useCallback(() => setView({ kind: 'home' }), []);

  const onSelectCategory = useCallback((id: CategoryId) => {
    setView({ kind: 'category', id });
  }, []);

  const onAction = useCallback((action: SettingsHomeAction) => {
    setView({ kind: 'action', id: action });
  }, []);

  if (view.kind === 'category') {
    const category = catalog.find((c) => c.id === view.id);
    if (!category) {
      // Defensive — should never happen because SettingsHome only emits ids
      // sourced from the same catalog. Drop back to home instead of crashing.
      return (
        <SettingsHome
          store={store}
          catalog={catalog}
          onSelectCategory={onSelectCategory}
          onAction={onAction}
          onQuit={onExit}
          version={version}
          productName={productName}
        />
      );
    }
    return (
      <CategoryScreen category={category} store={store} onBack={goHome} />
    );
  }

  if (view.kind === 'action') {
    switch (view.id) {
      case 'verify':
        return <VerifyScreen onBack={goHome} />;
      case 'doctor':
        return <DoctorScreen onBack={goHome} />;
      case 'export':
        return <DashboardExport onBack={goHome} />;
      case 'import':
        return <ImportScreen store={store} catalog={catalog} onBack={goHome} />;
      case 'uninstall':
        return <DashboardUninstall onBack={goHome} />;
    }
  }

  return (
    <SettingsHome
      store={store}
      catalog={catalog}
      onSelectCategory={onSelectCategory}
      onAction={onAction}
      onQuit={onExit}
      version={version}
      productName={productName}
    />
  );
}

// ---------------------------------------------------------------------------
// InkRoot — production shell compositor (SP6+)
//
// Wraps the router logic in the App shell (Header / Sidebar / Footer).
// `initialRoute` seeds the starting view (used in tests and future deep-link
// support); entry.ts always omits it, defaulting to 'home'.
// ---------------------------------------------------------------------------

export interface InkRootProps {
  store: SettingsStore;
  catalog: ReadonlyArray<CategoryDef>;
  onExit?: () => void;
  version?: string;
  productName?: string;
  /** Optional toast store for reactive toast prop. If omitted, toast is null. */
  toastStore?: ToastStore;
  /**
   * Seed the initial view. Defaults to 'home'. Added as a testability hook;
   * production entry always renders with default 'home' and drives navigation
   * via keyboard.
   */
  initialRoute?: string;
}

function resolveInitialView(initialRoute: string | undefined): ScreenView {
  if (!initialRoute || initialRoute === 'home') return { kind: 'home' };
  const r = DEFAULT_ROUTES.find((x) => x.id === initialRoute);
  if (!r) return { kind: 'home' };
  return r.group === 'settings'
    ? { kind: 'category', id: r.id as CategoryId }
    : { kind: 'action', id: r.id as SettingsHomeAction };
}

function computeActiveRoute(view: ScreenView): string {
  if (view.kind === 'home') return 'browser';
  if (view.kind === 'category') return view.id;
  return view.id;
}

function computePaneTitle(view: ScreenView, catalog: ReadonlyArray<CategoryDef>): string {
  if (view.kind === 'home') return 'Settings';
  if (view.kind === 'category') {
    const cat = catalog.find((c) => c.id === view.id);
    return cat?.label ?? view.id;
  }
  const label = DEFAULT_ROUTES.find((r) => r.id === view.id)?.label;
  return label ?? view.id;
}

function computeDirtyByCategory(dirtyKeys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of dirtyKeys) {
    const seg = key.split('.')[0] ?? key;
    out[seg] = (out[seg] ?? 0) + 1;
  }
  return out;
}

export function InkRoot(props: InkRootProps): React.ReactElement {
  const {
    store,
    catalog,
    onExit = () => {},
    version,
    productName,
    toastStore,
    initialRoute,
  } = props;

  const [view, setView] = useState<ScreenView>(() => resolveInitialView(initialRoute));
  const [focusedPane, setFocusedPane] = useState<'sidebar' | 'main'>('sidebar');
  const [inEditBuffer, setInEditBuffer] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Reactive pending count
  const [pending, setPending] = useState(() => store.dirtyKeys().length);
  useEffect(() => {
    const unsub = store.subscribe(() => setPending(store.dirtyKeys().length));
    return unsub;
  }, [store]);

  // Reactive toast
  const [toast, setToast] = useState<{ message: string; severity: 'ok' | 'warn' | 'err' } | null>(
    () => toastStore?.current() ?? null,
  );
  useEffect(() => {
    if (!toastStore) return;
    const unsub = toastStore.subscribe(() => setToast(toastStore.current()));
    return unsub;
  }, [toastStore]);

  // Build palette index once per catalog change
  const paletteEntries = useMemo(
    () => buildPaletteIndex({ catalog: [...catalog], actionLabels: ACTION_LABELS }),
    [catalog],
  );

  // Global key handler: Ctrl-K opens palette; ? opens help (when not in edit buffer)
  useInput((_input, key) => {
    if (paletteOpen || helpOpen) return;
    if (key.ctrl && _input === 'k') {
      setPaletteOpen(true);
      return;
    }
    if (_input === '?' && !inEditBuffer) {
      setHelpOpen(true);
      return;
    }
    if (key.tab) setFocusedPane((p) => p === 'sidebar' ? 'main' : 'sidebar');
  });

  const handlePalettePick = useCallback((entry: PaletteEntry) => {
    setPaletteOpen(false);
    if (entry.kind === 'category') {
      setView({ kind: 'category', id: entry.id as CategoryId });
      setFocusedPane('main');
    } else if (entry.kind === 'field' && entry.path) {
      // entry.id is the field key; entry.path is the category id.
      // Thread initialFocusKey so CategoryScreen pre-positions the cursor.
      setView({ kind: 'category', id: entry.path as CategoryId, initialFocusKey: entry.id });
      setFocusedPane('main');
    } else if (entry.kind === 'action') {
      setView({ kind: 'action', id: entry.id as SettingsHomeAction });
      setFocusedPane('main');
    }
  }, []);

  const handlePaletteClose = useCallback(() => setPaletteOpen(false), []);
  const handleHelpClose = useCallback(() => setHelpOpen(false), []);

  const goHome = useCallback(() => {
    setView({ kind: 'home' });
    setFocusedPane('sidebar');
  }, []);

  const onSelectCategory = useCallback((id: CategoryId) => {
    setView({ kind: 'category', id });
    setFocusedPane('main');
  }, []);

  const onAction = useCallback((action: SettingsHomeAction) => {
    setView({ kind: 'action', id: action });
    setFocusedPane('main');
  }, []);

  const handleSelectRoute = useCallback((id: string) => {
    const route = DEFAULT_ROUTES.find((r) => r.id === id);
    if (!route) return;
    if (route.group === 'settings') {
      setView({ kind: 'category', id: id as CategoryId });
    } else {
      setView({ kind: 'action', id: id as SettingsHomeAction });
    }
    setFocusedPane('main');
  }, []);

  const activeRoute = computeActiveRoute(view);
  const paneTitle = computePaneTitle(view, catalog);
  const dirtyByCategory = computeDirtyByCategory(store.dirtyKeys());

  let currentScreen: React.ReactElement;

  if (view.kind === 'category') {
    const category = catalog.find((c) => c.id === view.id);
    if (!category) {
      currentScreen = (
        <SettingsHome
          store={store}
          catalog={catalog}
          onSelectCategory={onSelectCategory}
          onAction={onAction}
          onQuit={onExit}
          version={version}
          productName={productName}
        />
      );
    } else {
      currentScreen = (
        <CategoryScreen
          category={category}
          store={store}
          onBack={goHome}
          onEditBufferChange={setInEditBuffer}
          initialFocusKey={view.initialFocusKey}
        />
      );
    }
  } else if (view.kind === 'action') {
    const actionId: SettingsHomeAction = view.id;
    switch (actionId) {
      case 'verify':
        currentScreen = <VerifyScreen onBack={goHome} />;
        break;
      case 'doctor':
        currentScreen = <DoctorScreen onBack={goHome} />;
        break;
      case 'export':
        currentScreen = <DashboardExport onBack={goHome} />;
        break;
      case 'import':
        currentScreen = <ImportScreen store={store} catalog={catalog} onBack={goHome} />;
        break;
      case 'uninstall':
        currentScreen = <DashboardUninstall onBack={goHome} />;
        break;
      default: {
        const _exhaustive: never = actionId;
        throw new Error(`Unhandled action: ${String(_exhaustive)}`);
      }
    }
  } else {
    currentScreen = (
      <SettingsHome
        store={store}
        catalog={catalog}
        onSelectCategory={onSelectCategory}
        onAction={onAction}
        onQuit={onExit}
        version={version}
        productName={productName}
      />
    );
  }

  return (
    <App
      routes={DEFAULT_ROUTES}
      activeRoute={activeRoute}
      dirtyByCategory={dirtyByCategory}
      status="ok"
      pending={pending}
      toast={toast}
      focusedPane={focusedPane}
      paneTitle={paneTitle}
      onSelectRoute={handleSelectRoute}
      paletteOpen={paletteOpen}
      paletteEntries={paletteEntries}
      onPalettePick={handlePalettePick}
      onPaletteClose={handlePaletteClose}
      helpOpen={helpOpen}
      onHelpClose={handleHelpClose}
    >
      {currentScreen}
    </App>
  );
}
