/**
 * MainMenu component — entry point for `config`/`dashboard` mode.
 *
 * Routes to every wizard screen standalone for reconfigure mode.
 * This is the screen-stack router entry from §5.1 of the umbrella spec.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ScreenId } from '../actions/index.js';

interface MenuItem {
  label: string;
  description: string;
  screen: ScreenId;
}

const MENU_ITEMS: MenuItem[] = [
  {
    label: 'System check',
    description: 'Re-run system requirements check',
    screen: 'syscheck',
  },
  {
    label: 'Browser engine',
    description: 'Change default browser for page rendering',
    screen: 'browser',
  },
  {
    label: 'Install / update components',
    description: 'Re-install or update ML models, search engine, browser',
    screen: 'install',
  },
  {
    label: 'Verify setup',
    description: 'Run post-install verification checks',
    screen: 'verify',
  },
  {
    label: 'Connect AI tools (MCP)',
    description: 'Add or change agent MCP config',
    screen: 'agents',
  },
  {
    label: 'Edit environment / flags',
    description: 'Tune search backend, cache, browser, logging settings',
    screen: 'env-editor',
  },
  {
    label: 'Review component toggles',
    description: 'Enable or disable individual components',
    screen: 'review',
  },
];

interface MainMenuProps {
  onNavigate: (screen: ScreenId) => void;
  onExit: () => void;
}

export function MainMenu({ onNavigate, onExit }: MainMenuProps) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : MENU_ITEMS.length - 1));
    } else if (key.downArrow) {
      setCursor((c) => (c < MENU_ITEMS.length - 1 ? c + 1 : 0));
    } else if (key.return) {
      const item = MENU_ITEMS[cursor];
      if (item) onNavigate(item.screen);
    } else if (key.escape || input === 'q') {
      onExit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Wigolo — reconfigure</Text>
      <Text dimColor>↑/↓ navigate · enter select · q/esc exit</Text>
      <Box flexDirection="column" marginTop={1}>
        {MENU_ITEMS.map((item, i) => {
          const isFocused = i === cursor;
          return (
            <Box key={item.screen} flexDirection="column">
              <Text>
                {isFocused ? <Text color="cyan">{'❯ '}</Text> : '  '}
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
        <Text dimColor>Press q or esc to exit</Text>
      </Box>
    </Box>
  );
}
