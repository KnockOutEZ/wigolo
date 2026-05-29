/**
 * CategoryScreen — generic schema-driven view for a single settings category.
 *
 * Reads visible fields from a `CategoryDef`, renders one `FieldRenderer` per
 * field, and owns the navigation state (focused field index + editing flag).
 * All value state lives in the supplied `SettingsStore`; CategoryScreen only
 * routes keystrokes and forwards `onChange` into `store.set(settingsPath, ...)`.
 *
 * Key routing:
 *   - ↑ / ↓        → move focus through visible fields (no wrap)
 *   - enter        → start editing the focused field (FieldRenderer drives
 *                    actual value change for selects/toggles)
 *   - esc          → cancel current edit, OR call `onBack()` when idle
 *   - s            → reserved for save; this slice fires `onSave` (no-op by
 *                    default). Real propagation lands in slice 6.
 *
 * Save is intentionally out of scope here — the ActionBar still surfaces the
 * pending count so users see their dirty state grow as they edit.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CategoryDef, FieldDef, Ctx } from '../schema/types.js';
import type { SettingsStore } from '../state/settings-store.js';
import { FieldRenderer } from './FieldRenderer.js';
import { ActionBar, type ActionBarHotkey } from './ActionBar.js';

export interface CategoryScreenProps {
  category: CategoryDef;
  store: SettingsStore;
  onBack: () => void;
  onSave?: () => void;
}

export function CategoryScreen(props: CategoryScreenProps): React.ReactElement {
  const { category, store, onBack, onSave } = props;

  // Force a re-render whenever the store mutates so pending markers + the
  // ActionBar count stay in sync with edits.
  const [, setTick] = useState(0);
  useEffect(() => {
    const unsub = store.subscribe(() => setTick((t) => t + 1));
    return unsub;
  }, [store]);

  const current = store.getCurrent();
  const pending = store.getPending();
  const ctx: Ctx = { current, pending };

  const visibleFields = useMemo<ReadonlyArray<FieldDef>>(
    () => category.fields.filter((f) => (f.visible ? f.visible(ctx) : true)),
    // ctx is rebuilt every render; recompute whenever store contents change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [category, JSON.stringify(current), JSON.stringify(pending)],
  );

  const [focusedIndex, setFocusedIndex] = useState(0);
  const [editing, setEditing] = useState(false);

  // Clamp focus if the visible-field list shrinks (e.g. a conditional flipped).
  useEffect(() => {
    if (focusedIndex >= visibleFields.length && visibleFields.length > 0) {
      setFocusedIndex(visibleFields.length - 1);
    }
  }, [visibleFields.length, focusedIndex]);

  const pendingCount = store.dirtyKeys().length;

  useInput((input, key) => {
    // While editing, FieldRenderer owns the keyboard. We only listen for
    // navigation and global hotkeys when idle.
    if (editing) return;

    if (key.upArrow) {
      setFocusedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setFocusedIndex((i) =>
        visibleFields.length === 0 ? 0 : Math.min(visibleFields.length - 1, i + 1),
      );
      return;
    }
    if (key.return) {
      // Only kinds with an edit buffer (text/number/path) transition into a
      // sustained "editing" mode. Select / toggle / readonly are atomic and
      // FieldRenderer handles them in a single keystroke.
      if (visibleFields.length === 0) return;
      const focused = visibleFields[focusedIndex];
      if (!focused) return;
      if (focused.kind === 'text' || focused.kind === 'number' || focused.kind === 'path') {
        setEditing(true);
      }
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
    if (input === 's') {
      if (onSave) onSave();
      return;
    }
  });

  const hotkeys: ReadonlyArray<ActionBarHotkey> = [
    { key: '↑↓', label: 'field' },
    { key: 'enter', label: 'edit' },
    { key: 's', label: `save ${pendingCount} pending` },
    { key: 'esc', label: 'back' },
    { key: 'q', label: 'quit' },
  ];

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{category.label}</Text>
        {category.description ? <Text dimColor>{category.description}</Text> : null}
      </Box>

      <Box flexDirection="column">
        {visibleFields.map((field, idx) => {
          const focused = idx === focusedIndex;
          const settingsPath = field.settingsPath;
          const pendingVal = pending[settingsPath];
          const currentVal = current[settingsPath];
          const value =
            pendingVal !== undefined
              ? pendingVal
              : currentVal !== undefined
                ? currentVal
                : field.default;
          const currentForRenderer =
            currentVal !== undefined ? currentVal : field.default;

          return (
            <FieldRenderer
              key={field.key}
              field={field}
              value={value}
              current={currentForRenderer}
              focused={focused}
              editing={focused && editing}
              onChange={(next) => {
                store.set(settingsPath, next);
              }}
              onEditStart={() => setEditing(true)}
              onEditDone={() => setEditing(false)}
              onEditCancel={() => setEditing(false)}
            />
          );
        })}
      </Box>

      <ActionBar pendingCount={pendingCount} hotkeys={hotkeys} />
    </Box>
  );
}
