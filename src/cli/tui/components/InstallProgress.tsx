import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useInstall, type InstallItem } from '../hooks/useInstall.js';
import type { BrowserChoice } from './BrowserSelect.js';

interface InstallProgressProps {
  browser: BrowserChoice;
  onComplete: () => void;
}

function formatTime(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function ItemLine({ item }: { item: InstallItem }) {
  const name = item.name.padEnd(18);

  switch (item.status) {
    case 'waiting':
      return <Text dimColor>  {'○'} {name} waiting...</Text>;
    case 'installing':
      return (
        <Box>
          <Text>  </Text>
          <Spinner label={`${name} installing...`} />
        </Box>
      );
    case 'done':
      return (
        <Text>
          {'  '}<Text color="green">{'✓'}</Text> {name}
          <Text dimColor>{item.timeMs ? formatTime(item.timeMs) : 'done'}</Text>
        </Text>
      );
    case 'failed':
      return (
        <Text>
          {'  '}<Text color="red">{'✗'}</Text> {name}
          <Text color="red">{item.error ?? 'failed'}</Text>
        </Text>
      );
    case 'skipped':
      return <Text dimColor>  {'–'} {name} skipped</Text>;
  }
}

export function InstallProgress({ browser, onComplete }: InstallProgressProps) {
  const { items, done } = useInstall(browser);

  useEffect(() => {
    if (done) {
      const timer = setTimeout(onComplete, 300);
      return () => clearTimeout(timer);
    }
  }, [done, onComplete]);

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Installing dependencies...</Text>
      <Box flexDirection="column" marginTop={1}>
        {items.map((item) => (
          <ItemLine key={item.id} item={item} />
        ))}
      </Box>
    </Box>
  );
}
