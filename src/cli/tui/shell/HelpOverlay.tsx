import React from 'react';
import { Box, Text, useInput } from 'ink';
import { semantic } from '../theme/palette.js';

const KEYBINDS: { key: string; desc: string }[] = [
  { key: '↑↓',  desc: 'Navigate list / fields' },
  { key: 'Tab', desc: 'Toggle sidebar ↔ main pane' },
  { key: '⏎',   desc: 'Select / confirm / begin edit' },
  { key: 'esc', desc: 'Back / cancel / close overlay' },
  { key: '⌃k',  desc: 'Open command palette' },
  { key: '⌃z',  desc: 'Undo last change' },
  { key: '?',   desc: 'Toggle this help overlay' },
  { key: 'q',   desc: 'Quit (when no pending changes)' },
];

interface HelpOverlayProps {
  onClose: () => void;
}

export function HelpOverlay({ onClose }: HelpOverlayProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === '?') {
      onClose();
    }
  }, { isActive: true });

  return (
    <Box
      borderStyle="round"
      borderColor={semantic.accentAlt}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      width={46}
    >
      <Text color={semantic.accentAlt} bold>Keyboard Shortcuts</Text>
      <Box marginTop={1} flexDirection="column">
        {KEYBINDS.map(({ key, desc }) => (
          <Box key={key}>
            <Box width={6}>
              <Text color={semantic.accent} bold>{key}</Text>
            </Box>
            <Text color={semantic.text}>{desc}</Text>
          </Box>
        ))}
      </Box>
      <Text color={semantic.textMuted}>esc · ? to close</Text>
    </Box>
  );
}
