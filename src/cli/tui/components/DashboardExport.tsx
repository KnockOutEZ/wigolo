/**
 * DashboardExport component — SP5 config export/import screen.
 *
 * Allows exporting the current persisted config to a portable JSON file
 * (secrets excluded) and importing from a previously exported file.
 * No business logic here — delegates to exportConfig / importConfig actions.
 */
import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { semantic } from '../theme/palette.js';

type MenuAction = 'export' | 'import';
type PhaseState = 'menu' | 'running' | 'done';

const MENU_ITEMS: Array<{ id: MenuAction; label: string; description: string }> = [
  {
    id: 'export',
    label: 'Export config',
    description: 'Save settings to ~/wigolo-config-export.json (secrets excluded)',
  },
  {
    id: 'import',
    label: 'Import config',
    description: 'Load settings from ~/wigolo-config-export.json',
  },
];

interface DashboardExportProps {
  onBack: () => void;
}

export function DashboardExport({ onBack }: DashboardExportProps) {
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<PhaseState>('menu');
  const [resultMsg, setResultMsg] = useState('');
  const [resultOk, setResultOk] = useState(false);

  const defaultExportPath = join(homedir(), 'wigolo-config-export.json');

  const runAction = useCallback(async (action: MenuAction) => {
    setPhase('running');

    try {
      const { exportConfig, importConfig } = await import('../actions/index.js');
      const configPath = process.env.WIGOLO_CONFIG_PATH ?? join(homedir(), '.wigolo', 'config.json');

      if (action === 'export') {
        const result = await exportConfig(defaultExportPath, configPath);
        setResultOk(result.ok);
        setResultMsg(
          result.ok
            ? `Exported to ${defaultExportPath} (secrets excluded)`
            : `Export failed: ${result.error}`,
        );
      } else {
        const result = await importConfig(defaultExportPath, configPath);
        setResultOk(result.ok);
        setResultMsg(
          result.ok
            ? `Imported from ${defaultExportPath}`
            : `Import failed: ${result.error}`,
        );
      }
    } catch (err) {
      setResultOk(false);
      setResultMsg(err instanceof Error ? err.message : String(err));
    }

    setPhase('done');
  }, [defaultExportPath]);

  useInput(useCallback((input, key) => {
    if (phase === 'running') return;
    if (phase === 'done') {
      if (key.escape || input === 'q' || key.return) onBack();
      return;
    }
    if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : MENU_ITEMS.length - 1));
    else if (key.downArrow) setCursor((c) => (c < MENU_ITEMS.length - 1 ? c + 1 : 0));
    else if (key.return) {
      const item = MENU_ITEMS[cursor];
      if (item) void runAction(item.id);
    } else if (key.escape || input === 'q') onBack();
  }, [phase, cursor, runAction, onBack]));

  if (phase === 'running') {
    return (
      <Box paddingX={2}>
        <Text color={semantic.warn}>Running…</Text>
      </Box>
    );
  }

  if (phase === 'done') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color={resultOk ? semantic.ok : semantic.err}>{resultMsg}</Text>
        <Box marginTop={1}>
          <Text dimColor>Press enter or q/esc to return</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Wigolo — export / import config</Text>
      <Text dimColor>Export path: {defaultExportPath}</Text>
      <Box flexDirection="column" marginTop={1}>
        {MENU_ITEMS.map((item, i) => {
          const isFocused = i === cursor;
          return (
            <Box key={item.id} flexDirection="column">
              <Text>
                {isFocused ? <Text color={semantic.accent}>{'❯ '}</Text> : '  '}
                <Text bold={isFocused}>{item.label}</Text>
              </Text>
              {isFocused && (
                <Box paddingLeft={4}>
                  <Text dimColor>{item.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate · enter select · q/esc back</Text>
      </Box>
    </Box>
  );
}
