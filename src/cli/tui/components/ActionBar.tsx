/**
 * ActionBar — single-row bottom strip listing global hotkeys.
 *
 * Used by CategoryScreen (and later SettingsHome). Visual emphasis tracks
 * pending state: bright when there are unsaved changes, dim when clean.
 *
 * Stateless. Parent owns pendingCount and the hotkeys array.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { semantic } from '../theme/palette.js';

export interface ActionBarHotkey {
  key: string;
  label: string;
}

export interface ActionBarProps {
  pendingCount: number;
  hotkeys: ReadonlyArray<ActionBarHotkey>;
}

export function ActionBar(props: ActionBarProps): React.ReactElement {
  const { pendingCount, hotkeys } = props;
  const dim = pendingCount === 0;

  return (
    <Box flexDirection="row" marginTop={1}>
      {hotkeys.map((hk, idx) => (
        <Box key={hk.key} flexDirection="row" marginRight={2}>
          <Text bold={!dim} dimColor={dim} color={dim ? undefined : semantic.accent}>
            {hk.key}
          </Text>
          <Text> </Text>
          <Text dimColor={dim}>{hk.label}</Text>
          {idx < hotkeys.length - 1 ? <Text dimColor> </Text> : null}
        </Box>
      ))}
    </Box>
  );
}
