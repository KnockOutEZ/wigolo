/**
 * DashboardUninstall component — SP5 full uninstall screen.
 *
 * Removes the data directory (~/.wigolo) and unwires all detected agent
 * MCP configs. Requires explicit confirmation before proceeding.
 * No business logic here — delegates to the uninstall action.
 */
import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { getConfig } from '../../../config.js';
import { signalUninstall } from '../state/uninstall-signal.js';
import { semantic } from '../theme/palette.js';
import { activityStore } from '../state/activity-store-instance.js';

type Phase = 'confirm' | 'running' | 'done';

interface DashboardUninstallProps {
  onBack: () => void;
}

export function DashboardUninstall({ onBack }: DashboardUninstallProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [confirmed, setConfirmed] = useState(false);
  const [resultLines, setResultLines] = useState<string[]>([]);
  const [resultOk, setResultOk] = useState(false);

  const runUninstall = useCallback(async () => {
    setPhase('running');
    const end = activityStore.begin('uninstall');
    try {
      const config = getConfig();
      const { uninstall } = await import('../actions/index.js');
      const result = await uninstall({ dataDir: config.dataDir, confirmed: true });

      const lines: string[] = [];
      if (result.dataDirRemoved) {
        lines.push(`Removed data directory: ${config.dataDir}`);
      }
      for (const ar of result.agentResults) {
        if (ar.error) {
          lines.push(`${ar.displayName}: error — ${ar.error}`);
        } else if (ar.removed.length > 0) {
          lines.push(`${ar.displayName}: removed ${ar.removed.join(', ')}`);
        } else {
          lines.push(`${ar.displayName}: nothing to remove`);
        }
      }
      if (lines.length === 0) {
        lines.push('Nothing found to remove.');
      }
      if (result.error) {
        lines.push(`Error: ${result.error}`);
      }

      setResultLines(lines);
      setResultOk(result.ok);
      setPhase('done');
    } finally {
      end();
    }
  }, []);

  useInput(useCallback((input, key) => {
    if (phase === 'running') return;

    if (phase === 'done') {
      if (key.escape || input === 'q' || key.return) {
        // After uninstall data is gone — signal so callers skip warmup, then exit
        signalUninstall();
        exit();
      }
      return;
    }

    // confirm phase
    if (input === 'y' || input === 'Y') {
      setConfirmed(true);
      void runUninstall();
    } else if (key.escape || input === 'q' || input === 'n' || input === 'N') {
      onBack();
    }
  }, [phase, runUninstall, onBack, exit]));

  if (phase === 'running') {
    return (
      <Box paddingX={2}>
        <Text color={semantic.warn}>Uninstalling wigolo…</Text>
      </Box>
    );
  }

  if (phase === 'done') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold color={resultOk ? semantic.ok : semantic.err}>
          {resultOk ? 'Wigolo uninstalled' : 'Uninstall encountered errors'}
        </Text>
        {resultLines.map((line, i) => (
          <Box key={i} paddingLeft={2}>
            <Text color={line.startsWith('Error') ? semantic.err : undefined}>{line}</Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>Press enter or q to exit</Text>
        </Box>
      </Box>
    );
  }

  // confirm phase
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold color={semantic.err}>Uninstall wigolo</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>This will permanently remove:</Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text>• All cached data and embeddings</Text>
          <Text>• ML models and browser data</Text>
          <Text>• MCP configs from all detected AI tools</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={semantic.warn}>Type y to confirm or n/esc to cancel: </Text>
        {confirmed && <Text color={semantic.ok}>y</Text>}
      </Box>
    </Box>
  );
}
