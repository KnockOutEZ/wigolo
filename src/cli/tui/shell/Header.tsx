import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import { semantic, palette } from '../theme/palette.js';
import { reducedMotion } from '../theme/motion-guard.js';
import { spinner } from '../theme/motion.js';
import type { ActivityStore } from '../state/activity-store.js';
import type { ReactNode } from 'react';
import { useState, useEffect } from 'react';

type Status = 'ok' | 'warn' | 'err';

export function toastColor(sev: Status): string {
  return sev === 'ok' ? semantic.ok : sev === 'warn' ? semantic.warn : semantic.err;
}

const GRADIENT_PHASES = [
  [palette.pink, palette.purple],
  [palette.purple, palette.pink],
] as const;

export function Header(props: {
  status: Status;
  pending: number;
  toast: { message: string; severity: Status } | null;
  activityStore?: ActivityStore;
}): JSX.Element {
  const rm = reducedMotion();

  const [busy, setBusy] = useState(() => props.activityStore?.busy() ?? false);
  const [pulseFrame, setPulseFrame] = useState(0);
  const [gradientPhase, setGradientPhase] = useState(0);

  // Subscribe to activityStore changes
  useEffect(() => {
    if (!props.activityStore) return;
    const unsub = props.activityStore.subscribe(() => {
      setBusy(props.activityStore!.busy());
    });
    return unsub;
  }, [props.activityStore]);

  // Pulse interval: advance every 250ms while busy and not reduced motion
  useEffect(() => {
    if (rm || !busy) {
      setPulseFrame(0);
      return;
    }
    const t = setInterval(() => setPulseFrame((f) => (f + 1) % spinner.pulse.length), 250);
    return () => clearInterval(t);
  }, [rm, busy]);

  // Gradient cycle: advance every 80ms while busy and not reduced motion
  useEffect(() => {
    if (rm || !busy) {
      setGradientPhase(0);
      return;
    }
    const t = setInterval(() => setGradientPhase((p) => (p + 1) % GRADIENT_PHASES.length), 80);
    return () => clearInterval(t);
  }, [rm, busy]);

  const dotColor =
    props.status === 'ok'
      ? semantic.ok
      : props.status === 'warn'
        ? semantic.warn
        : semantic.err;

  const dotChar = busy && !rm ? spinner.pulse[pulseFrame] : spinner.pulse[0];

  const gradientColors = GRADIENT_PHASES[gradientPhase];

  const title: ReactNode = rm ? (
    <Text color={semantic.accent} bold>wigolo</Text>
  ) : (
    <Gradient colors={[...gradientColors]}><Text bold>wigolo</Text></Gradient>
  );

  return (
    <Box justifyContent="space-between" paddingX={1}>
      {title}
      <Box gap={2}>
        <Text color={dotColor}>{dotChar}</Text>
        {props.pending > 0 && (
          <Text color={semantic.accent}>{props.pending} pending</Text>
        )}
        {props.toast && (
          <Text color={toastColor(props.toast.severity)}>{props.toast.message}</Text>
        )}
      </Box>
    </Box>
  );
}
