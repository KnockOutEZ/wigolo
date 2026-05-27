/**
 * ReviewToggles screen — shows every installable component as an opt-out row.
 *
 * Each row shows: name · purpose · disk/time cost · default.
 * Space toggles, Enter confirms. Toggled-off components will be skipped during
 * install (the toggleMap is passed up to the parent, which controls useInstall).
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  COMPONENT_REGISTRY,
  FIREFOX_COMPONENT,
  buildDefaultToggles,
} from '../actions/index.js';
import type { ToggleMap, ComponentMeta } from '../actions/index.js';
import type { BrowserChoice } from './BrowserSelect.js';

interface ReviewTogglesProps {
  browser: BrowserChoice;
  onComplete: (toggleMap: ToggleMap) => void;
}

export function ReviewToggles({ browser, onComplete }: ReviewTogglesProps) {
  const includeFirefox = browser === 'firefox';
  const components: ComponentMeta[] = [
    ...COMPONENT_REGISTRY,
    ...(includeFirefox ? [FIREFOX_COMPONENT] : []),
  ];

  const [toggles, setToggles] = useState<ToggleMap>(() =>
    buildDefaultToggles(includeFirefox),
  );
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : components.length - 1));
    } else if (key.downArrow) {
      setCursor((c) => (c < components.length - 1 ? c + 1 : 0));
    } else if (input === ' ') {
      const id = components[cursor]!.id;
      setToggles((prev) => ({ ...prev, [id]: !prev[id] }));
    } else if (key.return) {
      onComplete(toggles);
    }
  });

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Review installation plan</Text>
      <Text dimColor>Toggle components off to skip · ↑/↓ navigate · space toggle · enter confirm</Text>
      <Box flexDirection="column" marginTop={1}>
        {components.map((c, i) => {
          const isFocused = i === cursor;
          const isOn = toggles[c.id] ?? c.defaultEnabled;
          return (
            <Box key={c.id} flexDirection="row">
              <Text>
                {isFocused ? <Text color="cyan">{'❯ '}</Text> : '  '}
                {isOn
                  ? <Text color="green">{'[on]  '}</Text>
                  : <Text dimColor>{'[off] '}</Text>
                }
                <Text bold={isFocused}>{c.name.padEnd(22)}</Text>
                <Text dimColor>{c.purpose.padEnd(40)}</Text>
                <Text color="yellow">{c.cost}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {Object.values(toggles).filter(Boolean).length} of {components.length} components enabled
        </Text>
      </Box>
    </Box>
  );
}
