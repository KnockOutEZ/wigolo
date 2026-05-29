/**
 * SettingsHome — top-level entry screen for the new settings TUI.
 *
 * Lists every category in the CATALOG, plus a horizontal action-row at the
 * bottom (Verify · Doctor · Export · Import · Uninstall). Pure component:
 * all value state lives in the supplied SettingsStore, all navigation is
 * delegated up through onSelectCategory / onAction / onQuit callbacks.
 *
 * Key routing (idle):
 *   - ↑ / ↓   move focus through category rows then into the action-row
 *   - enter   on a category row → onSelectCategory(id)
 *             on an action      → onAction(name)
 *   - q       quit; if the store is dirty, prompt for confirmation first
 *   - ?       toggle a one-line inline help overlay
 *
 * Real action screens (Verify/Doctor/Export/Import/Uninstall) land in slice 11.
 * Multi-category CATALOG and propagation/save land in later slices.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CategoryDef, CategoryId } from '../schema/types.js';
import type { SettingsStore } from '../state/settings-store.js';

export type SettingsHomeAction =
  | 'verify'
  | 'doctor'
  | 'export'
  | 'import'
  | 'uninstall';

export interface SettingsHomeProps {
  store: SettingsStore;
  catalog: ReadonlyArray<CategoryDef>;
  onSelectCategory: (id: CategoryId) => void;
  onAction: (action: SettingsHomeAction) => void;
  onQuit: () => void;
  version?: string;
  productName?: string;
}

interface ActionDef {
  id: SettingsHomeAction;
  label: string;
}

const ACTIONS: ReadonlyArray<ActionDef> = [
  { id: 'verify', label: 'Verify' },
  { id: 'doctor', label: 'Doctor' },
  { id: 'export', label: 'Export' },
  { id: 'import', label: 'Import' },
  { id: 'uninstall', label: 'Uninstall' },
];

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function categoryPreview(
  category: CategoryDef,
  current: Readonly<Record<string, unknown>>,
): string {
  // Find the first visible field with a value (or a default) and render that
  // as the right-column summary. Keeps the screen useful even with one
  // category in CATALOG today.
  for (const field of category.fields) {
    const raw = current[field.settingsPath];
    const value = raw !== undefined ? raw : field.default;
    if (value === undefined || value === null) continue;
    const rendered = formatValue(value);
    if (rendered.length === 0) continue;
    return rendered;
  }
  // Fallback — first option of first select field if nothing else.
  for (const field of category.fields) {
    if (field.kind === 'select' && field.options && field.options.length > 0) {
      const first = field.options[0];
      if (first) return first.value;
    }
  }
  return '';
}

export function SettingsHome(props: SettingsHomeProps): React.ReactElement {
  const {
    store,
    catalog,
    onSelectCategory,
    onAction,
    onQuit,
    version,
    productName,
  } = props;

  // Re-render whenever the store mutates so previews stay in sync with edits
  // committed from sub-screens.
  const [, setTick] = useState(0);
  useEffect(() => {
    const unsub = store.subscribe(() => setTick((t) => t + 1));
    return unsub;
  }, [store]);

  const current = store.getCurrent();

  const categoryRows = useMemo(
    () =>
      catalog.map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description,
        preview: categoryPreview(c, current),
      })),
    // current is rebuilt every render; recompute when its JSON shape changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, JSON.stringify(current)],
  );

  const totalRows = categoryRows.length + ACTIONS.length;
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [helpVisible, setHelpVisible] = useState(false);

  // Clamp focus if the catalog shrinks (future-proofing).
  useEffect(() => {
    if (focusedIndex >= totalRows && totalRows > 0) {
      setFocusedIndex(totalRows - 1);
    }
  }, [totalRows, focusedIndex]);

  const inActionRow = focusedIndex >= categoryRows.length;
  const actionIndex = focusedIndex - categoryRows.length;
  const pendingCount = store.dirtyKeys().length;

  useInput((input, key) => {
    // Quit confirmation has highest priority — it owns the keyboard until
    // resolved.
    if (confirmQuit) {
      if (input === 'y' || input === 'Y') {
        setConfirmQuit(false);
        onQuit();
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        setConfirmQuit(false);
        return;
      }
      return;
    }

    if (key.upArrow) {
      setFocusedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setFocusedIndex((i) =>
        totalRows === 0 ? 0 : Math.min(totalRows - 1, i + 1),
      );
      return;
    }
    if (key.return) {
      if (inActionRow) {
        const action = ACTIONS[actionIndex];
        if (action) onAction(action.id);
        return;
      }
      const row = categoryRows[focusedIndex];
      if (row) onSelectCategory(row.id);
      return;
    }
    if (input === 'q') {
      if (pendingCount > 0) {
        setConfirmQuit(true);
        return;
      }
      onQuit();
      return;
    }
    if (input === '?') {
      setHelpVisible((v) => !v);
      return;
    }
  });

  const titleLine = (() => {
    const name = productName ?? 'wigolo';
    return version ? `${name} ${version}` : name;
  })();

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{titleLine}</Text>
        <Text dimColor>Settings</Text>
      </Box>

      <Box flexDirection="column">
        {categoryRows.map((row, idx) => {
          const focused = idx === focusedIndex && !inActionRow;
          return (
            <Box key={row.id} flexDirection="row">
              <Text>
                {focused ? <Text color="cyan">{'❯ '}</Text> : '  '}
                <Text bold={focused} inverse={focused}>
                  {row.label}
                </Text>
                <Text>{'  '}</Text>
                <Text dimColor>{row.preview}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="row" marginTop={1}>
        {ACTIONS.map((action, idx) => {
          const focused = inActionRow && idx === actionIndex;
          return (
            <Box key={action.id} flexDirection="row" marginRight={2}>
              <Text>
                {focused ? <Text color="cyan">{'❯ '}</Text> : '  '}
                <Text bold={focused} inverse={focused}>
                  {action.label}
                </Text>
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="row" marginTop={1}>
        <Text dimColor>
          ↑↓ navigate · enter open · q quit · ? help
          {pendingCount > 0 ? `  (${pendingCount} pending)` : ''}
        </Text>
      </Box>

      {helpVisible ? (
        <Box marginTop={1}>
          <Text dimColor>
            Pick a category to edit. Bottom row runs Verify / Doctor /
            Export / Import / Uninstall. Press q to quit.
          </Text>
        </Box>
      ) : null}

      {confirmQuit ? (
        <Box marginTop={1}>
          <Text color="yellow">
            {`Discard ${pendingCount} pending change${pendingCount === 1 ? '' : 's'}? (y/N)`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
