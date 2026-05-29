/**
 * FieldRenderer — generic Ink component that renders one schema-driven field.
 *
 * Stateless except for an ephemeral edit buffer used while editing text-like
 * inputs (text/number/path). Edit-mode is parent-controlled via the `editing`
 * prop; ALL persistent value state lives in the parent's settings-store.
 *
 * Field kinds handled in this slice:
 *   - select   — left/right arrows cycle options; wraps at ends
 *   - toggle   — enter flips boolean
 *   - text     — typed input; enter commits, esc cancels
 *   - number   — typed input; enter commits if in [min,max]; esc cancels
 *   - path     — same as text, with display-only ~/  for homedir prefix
 *   - readonly — never focusable, never fires onChange
 *   - masked   — secret display (`****<last4>`); `r` replace / `x` remove;
 *                edit mode buffer never round-trips through props (typed
 *                value flows out via onChange on enter).
 *
 * Deferred (later slices): multiselect (slice 9).
 */
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import os from 'node:os';
import type { FieldDef } from '../schema/types.js';

export interface FieldRendererProps {
  field: FieldDef;
  value: unknown;
  current?: unknown;
  focused: boolean;
  editing: boolean;
  onChange: (next: unknown) => void;
  onEditStart: () => void;
  onEditDone: () => void;
  onEditCancel: () => void;
}

function displayPath(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) return '';
  const home = os.homedir();
  if (v === home) return '~';
  if (v.startsWith(home + '/')) return '~/' + v.slice(home.length + 1);
  return v;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function maskedSummary(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  const tail = value.slice(-4);
  return `****${tail}`;
}

function renderValue(field: FieldDef, value: unknown): string {
  switch (field.kind) {
    case 'toggle':
      return value ? 'on' : 'off';
    case 'path':
      return displayPath(value);
    case 'number':
      return value === undefined || value === null ? '' : String(value);
    case 'select': {
      // Show the raw value (matches schema/env-var semantics) — labels live in
      // help text / options panel when editing.
      return value === undefined || value === null ? '' : String(value);
    }
    case 'masked':
      return maskedSummary(value);
    case 'readonly':
    case 'text':
    default:
      return value === undefined || value === null ? '' : String(value);
  }
}

export function FieldRenderer(props: FieldRendererProps): React.ReactElement {
  const {
    field,
    value,
    current,
    focused,
    editing,
    onChange,
    onEditStart,
    onEditDone,
    onEditCancel,
  } = props;

  // Ephemeral buffer used only for text/number/path/masked while editing.
  const [buffer, setBuffer] = useState<string>(() => {
    if (field.kind === 'path') return displayPath(value);
    // Masked never pre-fills the buffer — secrets are write-once from the user.
    if (field.kind === 'masked') return '';
    return value === undefined || value === null ? '' : String(value);
  });

  // Reset buffer whenever we (re)enter editing or the underlying value changes
  // outside of editing.
  useEffect(() => {
    if (editing && (field.kind === 'text' || field.kind === 'number' || field.kind === 'path')) {
      if (field.kind === 'path') setBuffer(displayPath(value));
      else setBuffer(value === undefined || value === null ? '' : String(value));
    }
    // Masked entry starts with a clean buffer every time we enter edit mode —
    // the prior secret never leaks back into the typed display.
    if (editing && field.kind === 'masked') {
      setBuffer('');
    }
  }, [editing, field.kind, value]);

  const isPending =
    current !== undefined && !valuesEqual(value, current);

  useInput(
    (input, key) => {
      // readonly is inert.
      if (field.kind === 'readonly') return;

      // Non-focused fields ignore all input.
      if (!focused) return;

      // SELECT — left/right cycles; enter is a no-op edit (immediate change).
      if (field.kind === 'select') {
        const opts = field.options ?? [];
        if (opts.length === 0) return;
        const idx = opts.findIndex((o) => o.value === value);
        const safeIdx = idx >= 0 ? idx : 0;
        if (key.rightArrow || (key.return && !editing)) {
          const next = opts[(safeIdx + 1) % opts.length];
          if (next && next.value !== value) {
            onChange(next.value);
          }
          if (key.return) onEditDone();
          return;
        }
        if (key.leftArrow) {
          const prev = opts[(safeIdx - 1 + opts.length) % opts.length];
          if (prev && prev.value !== value) {
            onChange(prev.value);
          }
          return;
        }
        return;
      }

      // TOGGLE — enter flips.
      if (field.kind === 'toggle') {
        if (key.return) {
          onChange(!value);
          onEditDone();
        }
        return;
      }

      // MASKED — secret input. When idle:
      //   - empty value → enter starts replace/edit mode.
      //   - set value   → `r` replaces, `x` removes.
      // When editing: typed buffer, enter commits via onChange(value), esc cancels.
      if (field.kind === 'masked') {
        if (!editing) {
          if (key.return) {
            onEditStart();
            return;
          }
          // Has-value branch: r=replace, x=remove. We treat absence of value
          // (empty string/null/undefined) as "no key set" — only `enter` works
          // there to avoid grabbing 'r'/'x' keystrokes the user might want
          // routed elsewhere when the field is intentionally empty.
          const hasValue = typeof value === 'string' && value.length > 0;
          if (!hasValue) return;
          if (input === 'r' || input === 'R') {
            onEditStart();
            return;
          }
          if (input === 'x' || input === 'X') {
            onChange(null);
            onEditDone();
            return;
          }
          return;
        }

        // editing === true
        if (key.escape) {
          onEditCancel();
          return;
        }
        if (key.return) {
          // Empty commit cancels rather than storing an empty secret.
          if (buffer.length === 0) {
            onEditCancel();
            return;
          }
          onChange(buffer);
          onEditDone();
          return;
        }
        if (key.backspace || key.delete) {
          setBuffer((b) => b.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setBuffer((b) => b + input);
          return;
        }
        return;
      }

      // TEXT / NUMBER / PATH
      if (field.kind === 'text' || field.kind === 'number' || field.kind === 'path') {
        if (!editing) {
          if (key.return) {
            onEditStart();
          }
          return;
        }

        // editing === true
        if (key.escape) {
          onEditCancel();
          return;
        }
        if (key.return) {
          // Commit if valid. For number, enforce min/max.
          if (field.kind === 'number') {
            const trimmed = buffer.trim();
            if (trimmed === '') {
              // Empty number rejected — cancel edit silently.
              onEditCancel();
              return;
            }
            const parsed = Number(trimmed);
            if (!Number.isFinite(parsed)) {
              onEditCancel();
              return;
            }
            const min = field.min ?? -Infinity;
            const max = field.max ?? Infinity;
            if (parsed < min || parsed > max) {
              // Reject silently — do NOT fire onChange.
              onEditCancel();
              return;
            }
            onChange(parsed);
            onEditDone();
            return;
          }

          // text / path: commit the buffer as-is.
          // For path, the buffer may contain a leading ~/ which we expand on commit.
          let next: string = buffer;
          if (field.kind === 'path') {
            if (next === '~') next = os.homedir();
            else if (next.startsWith('~/')) next = os.homedir() + next.slice(1);
          }
          onChange(next);
          onEditDone();
          return;
        }
        if (key.backspace || key.delete) {
          setBuffer((b) => b.slice(0, -1));
          return;
        }
        // Plain character input.
        if (input && !key.ctrl && !key.meta) {
          // For number, only accept digits, minus, and decimal point.
          if (field.kind === 'number') {
            if (!/^[0-9.\-]$/.test(input)) return;
          }
          setBuffer((b) => b + input);
          return;
        }
      }
    },
    { isActive: focused && field.kind !== 'readonly' },
  );

  // Display string
  const display = (() => {
    if (
      editing &&
      (field.kind === 'text' || field.kind === 'number' || field.kind === 'path')
    ) {
      return buffer;
    }
    if (editing && field.kind === 'masked') {
      // Echo asterisks, never the typed characters.
      return '*'.repeat(buffer.length);
    }
    if (field.kind === 'masked') {
      const hasValue = typeof value === 'string' && value.length > 0;
      if (!hasValue) return '[type to enter]';
      return renderValue(field, value);
    }
    return renderValue(field, value);
  })();

  const labelText = field.label;
  const valueColor = isPending ? 'yellow' : undefined;
  const pendingMarker = isPending ? ' *' : '';
  const maskedHasValue =
    field.kind === 'masked' && typeof value === 'string' && value.length > 0;
  const showMaskedHotkeys = field.kind === 'masked' && !editing && maskedHasValue && focused;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text>
          {focused ? <Text color="cyan">{'❯ '}</Text> : '  '}
          <Text bold={focused} inverse={focused && !editing}>
            {labelText}
          </Text>
          <Text>{'  '}</Text>
          {editing && (field.kind === 'text' || field.kind === 'number' || field.kind === 'path' || field.kind === 'masked') ? (
            <Text color="cyan">
              {display}
              <Text color="cyan" inverse>
                {' '}
              </Text>
            </Text>
          ) : (
            <Text color={valueColor}>
              {display}
              {pendingMarker}
            </Text>
          )}
          {showMaskedHotkeys && (
            <Text dimColor>{'   [r] Replace [x] Remove'}</Text>
          )}
        </Text>
      </Box>
      {field.help && (
        <Box paddingLeft={4}>
          <Text dimColor>{field.help}</Text>
        </Box>
      )}
      {field.futureNote && (
        <Box paddingLeft={4}>
          <Text dimColor>{field.futureNote}</Text>
        </Box>
      )}
    </Box>
  );
}
