import React from 'react';
import { Box, Text } from 'ink';
import { Select } from '@inkjs/ui';

export type BrowserChoice = 'chromium' | 'firefox';

interface BrowserSelectProps {
  onComplete: (browser: BrowserChoice) => void;
}

const OPTIONS = [
  { label: 'Chromium — most compatible (recommended)', value: 'chromium' as const },
  { label: 'Firefox — privacy-focused', value: 'firefox' as const },
];

export function BrowserSelect({ onComplete }: BrowserSelectProps) {
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Browser Engine</Text>
      <Text dimColor>Choose your default. You can change this later in config.</Text>
      <Box marginTop={1}>
        <Select options={OPTIONS} onChange={(v: string) => onComplete(v as BrowserChoice)} />
      </Box>
    </Box>
  );
}
