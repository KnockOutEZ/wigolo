import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useVerify, type VerifyItem } from '../hooks/useVerify.js';

interface VerificationProps {
  dataDir: string;
  onComplete: () => void;
}

function VerifyLine({ item }: { item: VerifyItem }) {
  const name = item.name.padEnd(14);

  switch (item.status) {
    case 'pending':
      return <Text dimColor>  {'○'} {name}</Text>;
    case 'checking':
      return (
        <Box>
          <Text>  </Text>
          <Spinner label={name} />
        </Box>
      );
    case 'pass':
      return (
        <Text>
          {'  '}<Text color="green">{'✓'}</Text> {name}
          <Text dimColor>{item.detail}</Text>
        </Text>
      );
    case 'fail':
      return (
        <Text>
          {'  '}<Text color="yellow">{'!'}</Text> {name}
          <Text color="yellow">{item.detail}</Text>
        </Text>
      );
    case 'warn':
      return (
        <Text>
          {'  '}<Text color="yellow">{'~'}</Text> {name}
          <Text dimColor>{item.detail}</Text>
        </Text>
      );
  }
}

export function Verification({ dataDir, onComplete }: VerificationProps) {
  const { items, done } = useVerify(dataDir);

  useEffect(() => {
    if (done) {
      const timer = setTimeout(onComplete, 400);
      return () => clearTimeout(timer);
    }
  }, [done, onComplete]);

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Verifying setup...</Text>
      <Box flexDirection="column" marginTop={1}>
        {items.filter((i) => i.status !== 'pending').map((item) => (
          <VerifyLine key={item.id} item={item} />
        ))}
      </Box>
    </Box>
  );
}
