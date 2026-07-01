/**
 * VerifyScreen — wrapper around the existing Verification component.
 *
 * Mounts Verification with the dataDir resolved from getConfig() and adds an
 * esc/q hotkey to return to SettingsHome. No verify logic lives here — all of
 * that is delegated to the SP6 Verification + useVerify hook stack.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { getConfig } from '../../../config.js';
import { Verification, type VerifyItem } from './Verification.js';
import { activityStore } from '../state/activity-store-instance.js';

interface VerifyScreenProps {
  onBack: () => void;
}

export function VerifyScreen({ onBack }: VerifyScreenProps): React.ReactElement {
  const [done, setDone] = useState(false);
  const endRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const end = activityStore.begin('verify');
    endRef.current = end;
    return () => {
      end();
      endRef.current = null;
    };
  }, []);

  const handleComplete = useCallback((_items: VerifyItem[]) => {
    setDone(true);
    endRef.current?.();
    endRef.current = null;
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
