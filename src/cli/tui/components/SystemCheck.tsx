import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useSystemCheck, type CheckItem } from '../hooks/useSystemCheck.js';

interface SystemCheckProps {
  onComplete: () => void;
  onFail: () => void;
}

function CheckLine({ check }: { check: CheckItem }) {
  const label = check.label.padEnd(14);

  switch (check.status) {
    case 'pending':
      return (
        <Text dimColor>  {'○'} {label}</Text>
      );
    case 'checking':
      return (
        <Box>
          <Text>  </Text>
          <Spinner label={label} />
        </Box>
      );
    case 'pass':
      return (
        <Text>  <Text color="green">{'✓'}</Text> {label} <Text dimColor>{check.detail}</Text></Text>
      );
    case 'fail':
      return (
        <Text>  <Text color="red">{'✗'}</Text> {label} <Text color="red">{check.detail}</Text></Text>
      );
    case 'optional':
      return (
        <Text>  <Text dimColor>{'~'}</Text> {label} <Text dimColor>{check.detail}</Text></Text>
      );
  }
}

export function SystemCheck({ onComplete, onFail }: SystemCheckProps) {
  const { checks, done, hardFailure } = useSystemCheck();

  useEffect(() => {
    if (done) {
      if (hardFailure) {
        onFail();
      } else {
        const timer = setTimeout(onComplete, 400);
        return () => clearTimeout(timer);
      }
    }
  }, [done, hardFailure, onComplete, onFail]);

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Checking your system...</Text>
      <Box flexDirection="column" marginTop={1}>
        {checks.filter((c) => c.status !== 'pending').map((check) => (
          <CheckLine key={check.id} check={check} />
        ))}
      </Box>
      {done && hardFailure && (
        <Box marginTop={1}>
          <Text color="red" bold>Setup cannot continue until the issues above are resolved.</Text>
        </Box>
      )}
    </Box>
  );
}
