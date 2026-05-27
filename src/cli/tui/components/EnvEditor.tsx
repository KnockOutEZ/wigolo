/**
 * EnvEditor screen — in-TUI editing of the curated env/flags subset.
 *
 * Groups vars by category. Arrow keys navigate; enter opens edit mode for
 * the focused var. On save the values are written to config.json via SP0's
 * writeEnvSettings action.
 *
 * This screen is accessible both from the wizard (after Review/Toggles) and
 * from the main-menu router in reconfigure mode.
 */
import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  CURATED_ENV_VARS,
  ENV_GROUP_LABELS,
  writeEnvSettings,
  readEnvSettings,
} from '../actions/index.js';
import type { EnvVarMeta, EnvGroupId } from '../actions/index.js';

interface EnvEditorProps {
  /** Called when user saves and exits */
  onComplete: (saved: Record<string, string>) => void;
  /** Called when user presses Escape to skip without saving */
  onSkip?: () => void;
  /** Optional custom config path (for tests) */
  configPath?: string;
}

type EditorMode = 'navigate' | 'editing';

function groupedVars(): [EnvGroupId, EnvVarMeta[]][] {
  const map = new Map<EnvGroupId, EnvVarMeta[]>();
  for (const v of CURATED_ENV_VARS) {
    if (!map.has(v.group)) map.set(v.group, []);
    map.get(v.group)!.push(v);
  }
  return [...map.entries()];
}

const FLAT_VARS = CURATED_ENV_VARS;

export function EnvEditor({ onComplete, onSkip, configPath }: EnvEditorProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    readEnvSettings(configPath),
  );
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<EditorMode>('navigate');
  const [editBuffer, setEditBuffer] = useState('');
  const [optionsCursor, setOptionsCursor] = useState(0);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  const focused = FLAT_VARS[cursor];

  const handleSave = useCallback(() => {
    try {
      writeEnvSettings(values, configPath);
      setSaved(true);
      onComplete(values);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [values, configPath, onComplete]);

  useInput(
    (input, key) => {
      if (mode === 'navigate') {
        if (key.upArrow) {
          setCursor((c) => (c > 0 ? c - 1 : FLAT_VARS.length - 1));
        } else if (key.downArrow) {
          setCursor((c) => (c < FLAT_VARS.length - 1 ? c + 1 : 0));
        } else if (key.return || input === 'e') {
          if (!focused) return;
          if (focused.options) {
            // Select mode: cycle options
            const idx = focused.options.indexOf(values[focused.settingsKey] ?? focused.defaultValue);
            setOptionsCursor(idx >= 0 ? idx : 0);
            setMode('editing');
          } else {
            // Free-form text edit
            setEditBuffer(values[focused.settingsKey] ?? focused.defaultValue);
            setMode('editing');
          }
        } else if (input === 's' || (key.ctrl && input === 's')) {
          handleSave();
        } else if (key.escape) {
          onSkip?.();
        }
      } else {
        // editing mode
        if (!focused) return;
        if (focused.options) {
          // Cycling options
          if (key.upArrow) {
            setOptionsCursor((c) => (c > 0 ? c - 1 : focused.options!.length - 1));
          } else if (key.downArrow) {
            setOptionsCursor((c) => (c < focused.options!.length - 1 ? c + 1 : 0));
          } else if (key.return) {
            const chosen = focused.options[optionsCursor] ?? focused.options[0]!;
            setValues((prev) => ({ ...prev, [focused.settingsKey]: chosen }));
            setMode('navigate');
          } else if (key.escape) {
            setMode('navigate');
          }
        } else {
          // Free-form text editing
          if (key.return) {
            setValues((prev) => ({ ...prev, [focused.settingsKey]: editBuffer }));
            setMode('navigate');
          } else if (key.escape) {
            setMode('navigate');
          } else if (key.backspace || key.delete) {
            setEditBuffer((b) => b.slice(0, -1));
          } else if (input && !key.ctrl && !key.meta) {
            setEditBuffer((b) => b + input);
          }
        }
      }
    },
  );

  const groups = groupedVars();
  let flatIdx = 0;

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Environment / flags editor</Text>
      <Text dimColor>↑/↓ navigate · enter/e edit · s save · esc skip</Text>
      <Box flexDirection="column" marginTop={1}>
        {groups.map(([group, vars]) => (
          <Box key={group} flexDirection="column" marginTop={1}>
            <Text bold color="cyan">{ENV_GROUP_LABELS[group]}</Text>
            {vars.map((v) => {
              const idx = flatIdx++;
              const isFocused = idx === cursor && mode === 'navigate';
              const isEditing = idx === cursor && mode === 'editing';
              const currentVal = values[v.settingsKey] ?? v.defaultValue;
              const isDefault = currentVal === v.defaultValue;

              return (
                <Box key={v.settingsKey} flexDirection="column">
                  <Box flexDirection="row">
                    <Text>
                      {isFocused ? <Text color="cyan">{'❯ '}</Text> : '  '}
                      <Text bold={isFocused}>{v.label.padEnd(28)}</Text>
                      {isEditing && !v.options ? (
                        <Text color="cyan">{editBuffer}<Text color="cyan" inverse> </Text></Text>
                      ) : (
                        <Text color={isDefault ? 'white' : 'green'}>
                          {currentVal}
                          {isDefault ? <Text dimColor> (default)</Text> : null}
                        </Text>
                      )}
                    </Text>
                  </Box>
                  {isEditing && v.options && (
                    <Box flexDirection="column" paddingLeft={4}>
                      {v.options.map((opt, oi) => (
                        <Text key={opt}>
                          {oi === optionsCursor
                            ? <Text color="cyan">{'❯ '}{opt}</Text>
                            : <Text dimColor>  {opt}</Text>
                          }
                        </Text>
                      ))}
                    </Box>
                  )}
                  {isFocused && !isEditing && (
                    <Box paddingLeft={4}>
                      <Text dimColor>{v.description}</Text>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
      {saved && (
        <Box marginTop={1}>
          <Text color="green">{'✓'} Settings saved to config.json</Text>
        </Box>
      )}
      {saveError && (
        <Box marginTop={1}>
          <Text color="red">{'✗'} Save failed: {saveError}</Text>
        </Box>
      )}
    </Box>
  );
}
