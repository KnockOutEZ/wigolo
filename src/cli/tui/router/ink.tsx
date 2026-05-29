/**
 * InkRouter — top-level shell for the new schema-driven settings TUI.
 *
 * Drives a simple state machine between SettingsHome and the per-category
 * CategoryScreen. Action-row buttons (Verify · Doctor · Export · Import ·
 * Uninstall) render placeholder screens this slice; real wiring lands in
 * slice 11.
 *
 * This router intentionally does NOT replace the legacy `ink-config.tsx` /
 * `ink-init.tsx` entry points. Those die in slice 10 when `entry.ts` is
 * introduced and the `wigolo config` / `wigolo init` CLI is rewired.
 */
import React, { useCallback, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CategoryDef, CategoryId } from '../schema/types.js';
import type { SettingsStore } from '../state/settings-store.js';
import { SettingsHome, type SettingsHomeAction } from '../components/SettingsHome.js';
import { CategoryScreen } from '../components/CategoryScreen.js';

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

const ACTION_LABELS: Record<SettingsHomeAction, string> = {
  verify: 'Verify',
  doctor: 'Doctor',
  export: 'Export',
  import: 'Import',
  uninstall: 'Uninstall',
};

interface ActionPlaceholderProps {
  action: SettingsHomeAction;
  onBack: () => void;
}

function ActionPlaceholder(props: ActionPlaceholderProps): React.ReactElement {
  const { action, onBack } = props;
  useInput((_input, key) => {
    if (key.escape) onBack();
  });
  return (
    <Box flexDirection="column">
      <Text>{`${ACTION_LABELS[action]} (coming in slice 11)`}</Text>
      <Box marginTop={1}>
        <Text dimColor>Press esc to return</Text>
      </Box>
    </Box>
  );
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
    return <ActionPlaceholder action={view.id} onBack={goHome} />;
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
