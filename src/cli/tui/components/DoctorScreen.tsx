/**
 * DoctorScreen — wrapper around the existing runDoctor() CLI action.
 *
 * Runs runDoctor() (which writes its diagnostic to stderr) and shows a single
 * line of status in the Ink frame. Doctor's stderr output appears above the
 * frame and is not corrupted by Ink's stdout-only renders.
 *
 * No doctor logic lives here — all checks are delegated to runDoctor() in
 * src/cli/doctor.ts.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { getConfig } from '../../../config.js';
import { semantic } from '../theme/palette.js';
import { activityStore } from '../state/activity-store-instance.js';

type Phase = 'running' | 'done' | 'error';

interface DoctorScreenProps {
  onBack: () => void;
}

export function DoctorScreen({ onBack }: DoctorScreenProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('running');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      const end = activityStore.begin('doctor');
      try {
        const { runDoctor } = await import('../../doctor.js');
        const code = await runDoctor(getConfig().dataDir);
        if (cancelled) return;
        setExitCode(code);
        setPhase('done');
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setPhase('error');
      } finally {
        end();
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useInput(useCallback((input, key) => {
    if (phase === 'running') return;
    if (key.escape || input === 'q' || key.return) onBack();
  }, [phase, onBack]));

  if (phase === 'running') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Running doctor diagnostic…</Text>
        <Box marginTop={1}>
          <Text dimColor>Output streams above this line.</Text>
        </Box>
      </Box>
    );
  }

  if (phase === 'error') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color={semantic.err} bold>Doctor failed to run</Text>
        <Box marginTop={1}>
          <Text color={semantic.err}>{errorMsg}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press enter or q/esc to return</Text>
        </Box>
      </Box>
    );
  }

  const ok = exitCode === 0;
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold color={ok ? semantic.ok : semantic.warn}>
        {ok ? 'Doctor: all required components OK' : 'Doctor: degraded (see output above)'}
      </Text>
      <Box marginTop={1}>
        <Text dimColor>Exit code: {exitCode}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press enter or q/esc to return</Text>
      </Box>
    </Box>
  );
}
