import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import { semantic, palette } from '../theme/palette.js';
import { reducedMotion } from '../theme/motion-guard.js';
import type { ReactNode } from 'react';

type Status = 'ok' | 'warn' | 'err';

export function toastColor(sev: Status): string {
  return sev === 'ok' ? semantic.ok : sev === 'warn' ? semantic.warn : semantic.err;
}

export function Header(props: {
  status: Status;
  pending: number;
  toast: { message: string; severity: Status } | null;
}): JSX.Element {
  const dotColor =
    props.status === 'ok'
      ? semantic.ok
      : props.status === 'warn'
        ? semantic.warn
        : semantic.err;

  const title: ReactNode = reducedMotion() ? (
    <Text color={semantic.accent} bold>wigolo</Text>
  ) : (
    <Gradient colors={[palette.pink, palette.purple]}><Text bold>wigolo</Text></Gradient>
  );

  return (
    <Box justifyContent="space-between" paddingX={1}>
      {title}
      <Box gap={2}>
        <Text color={dotColor}>●</Text>
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
