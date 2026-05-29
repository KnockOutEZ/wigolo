/**
 * InkRouter — top-level shell for the schema-driven settings TUI.
 *
 * Drives a simple state machine between SettingsHome, the per-category
 * CategoryScreen, and the action-row screens (Verify · Doctor · Export ·
 * Import · Uninstall). Each action mounts the relevant component from
 * components/ — no business logic lives in this router.
 *
 * Hosted by `entry.ts` (slice 10) which selects between this router and the
 * 4-step Wizard, depending on first-run state.
 *
 * SP6: `InkRoot` (named export) wraps InkRouter with the App shell
 * (Header / Sidebar / Footer). The wizard route bypasses the shell entirely —
 * entry.ts renders WizardSteps directly when phase === 'wizard'.
 */
import React, { useCallback, useEffect, useState } from 'react';
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

type ScreenView =
  | { kind: 'home' }
  | { kind: 'category'; id: CategoryId }
  | { kind: 'action'; id: SettingsHomeAction };

export interface InkRouterProps {
  store: SettingsStore;
  catalog: ReadonlyArray<CategoryDef>;
  onExit: () => void;
  version?: string;
  productName?: string;
}

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
// InkRoot — testability-friendly shell compositor (SP6)
//
// Wraps InkRouter with the App shell (Header / Sidebar / Footer). The
// `initialRoute` prop defaults to 'home' and matches the existing first-mount
// behaviour; the integration test uses it to seed the starting view without
// reaching for entry.ts internals.
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
  } = props;

  const [view, setView] = useState<ScreenView>({ kind: 'home' });
  const [focusedPane, setFocusedPane] = useState<'sidebar' | 'main'>('sidebar');

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

  // Tab key toggles focus between sidebar and main
  useInput((_input, key) => {
    if (key.tab) setFocusedPane((p) => p === 'sidebar' ? 'main' : 'sidebar');
  });

  const goHome = useCallback(() => setView({ kind: 'home' }), []);

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
      currentScreen = <CategoryScreen category={category} store={store} onBack={goHome} />;
    }
  } else if (view.kind === 'action') {
    switch (view.id) {
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
    >
      {currentScreen}
    </App>
  );
}
