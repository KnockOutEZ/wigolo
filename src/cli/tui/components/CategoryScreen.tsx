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
 *   - enter        → start editing the focused field; on edit-done, blur()
 *                    is called which autosaves the field to disk.
 *   - esc          → cancel current edit, OR call `onBack()` when idle
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CategoryDef, FieldDef, Ctx } from '../schema/types.js';
import type { SettingsStore } from '../state/settings-store.js';
import { FieldRenderer } from './FieldRenderer.js';
import { ActionBar, type ActionBarHotkey } from './ActionBar.js';
import { createLogger } from '../../../logger.js';

const logger = createLogger('cli');

export interface CategoryScreenProps {
  category: CategoryDef;
  store: SettingsStore;
  onBack: () => void;
  onEditBufferChange?: (editing: boolean) => void;
  /** If set, CategoryScreen initialises focus on the field with this key. */
  initialFocusKey?: string;
}

export function CategoryScreen(props: CategoryScreenProps): React.ReactElement {
  const { category, store, onBack, onEditBufferChange, initialFocusKey } = props;

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

  const [focusedIndex, setFocusedIndex] = useState(() => {
    if (!initialFocusKey) return 0;
    const idx = category.fields.findIndex((f) => f.key === initialFocusKey);
    return idx >= 0 ? idx : 0;
  });
  const [editing, setEditing] = useState(false);

  // Per-field savedAt timestamps — keyed by settingsPath.
  // Set to Date.now() on successful blur; the FieldRenderer clears its own
  // timer; we only need to propagate the timestamp, not reset it ourselves.
  const [savedAtByPath, setSavedAtByPath] = useState<Record<string, number | null>>({});

  const applyEditing = useCallback((next: boolean) => {
    setEditing(next);
    onEditBufferChange?.(next);
  }, [onEditBufferChange]);

  // On unmount, reset the edit-buffer flag so InkRoot doesn't get stuck with
  // inEditBuffer=true if the user navigates away while a field is active.
  useEffect(() => {
    return () => {
      onEditBufferChange?.(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        applyEditing(true);
      }
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
  });

  const hotkeys: ReadonlyArray<ActionBarHotkey> = [
    { key: '↑↓', label: 'field' },
    { key: '⏎', label: 'edit · autosave' },
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
              onEditStart={() => applyEditing(true)}
              onEditDone={() => {
                applyEditing(false);
                void store.blur(settingsPath).then(() => {
                  setSavedAtByPath((prev) => ({ ...prev, [settingsPath]: Date.now() }));
                }).catch((err) => {
                  logger.error('blur failed', { path: settingsPath, err: String(err) });
                });
              }}
              onEditCancel={() => applyEditing(false)}
              savedAt={savedAtByPath[settingsPath] ?? null}
            />
          );
        })}
      </Box>

      <ActionBar pendingCount={pendingCount} hotkeys={hotkeys} />
    </Box>
  );
}
