/**
 * VerifyScreen — slice 11 wrapper around the existing Verification component.
 *
 * Mounts Verification with the dataDir resolved from getConfig() and adds an
 * esc/q hotkey to return to SettingsHome. No verify logic lives here — all of
 * that is delegated to the SP6 Verification + useVerify hook stack.
 */
import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { getConfig } from '../../../config.js';
import { Verification, type VerifyItem } from './Verification.js';

interface VerifyScreenProps {
  onBack: () => void;
}

export function VerifyScreen({ onBack }: VerifyScreenProps): React.ReactElement {
  const [done, setDone] = useState(false);

  const handleComplete = useCallback((_items: VerifyItem[]) => {
    setDone(true);
  }, []);

  useInput((input, key) => {
    if (!done) return;
    if (key.escape || input === 'q' || key.return) onBack();
  });

  const dataDir = getConfig().dataDir;

  return (
    <Box flexDirection="column">
      <Verification dataDir={dataDir} onComplete={handleComplete} />
      {done ? (
        <Box marginTop={1} paddingX={2}>
          <Text dimColor>Press enter or q/esc to return</Text>
        </Box>
      ) : null}
    </Box>
  );
}
