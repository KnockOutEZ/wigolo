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
 */
import React, { useCallback, useState } from 'react';
import type { CategoryDef, CategoryId } from '../schema/types.js';
import type { SettingsStore } from '../state/settings-store.js';
import { SettingsHome, type SettingsHomeAction } from '../components/SettingsHome.js';
import { CategoryScreen } from '../components/CategoryScreen.js';
import { VerifyScreen } from '../components/VerifyScreen.js';
import { DoctorScreen } from '../components/DoctorScreen.js';
import { DashboardExport } from '../components/DashboardExport.js';
import { ImportScreen } from '../components/ImportScreen.js';
import { DashboardUninstall } from '../components/DashboardUninstall.js';

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
