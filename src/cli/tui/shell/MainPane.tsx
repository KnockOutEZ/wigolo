import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useState, useEffect, useRef } from 'react';
import { borders } from '../theme/borders.js';
import { semantic } from '../theme/palette.js';
import { reducedMotion } from '../theme/motion-guard.js';

type TransitionPhase = 'idle' | 'dimming';

export function MainPane(props: {
  title: string;
  focused: boolean;
  children: ReactNode;
  routeId?: string;
}): JSX.Element {
  const style = props.focused ? borders.active : borders.box;
  const rm = reducedMotion();

  const [phase, setPhase] = useState<TransitionPhase>('idle');
  const prevRouteRef = useRef<string | undefined>(props.routeId);

  useEffect(() => {
    if (rm) return;
    if (props.routeId === undefined) return;
    if (prevRouteRef.current === props.routeId) return;

    prevRouteRef.current = props.routeId;
    setPhase('dimming');
    const t = setTimeout(() => setPhase('idle'), 16);
    return () => clearTimeout(t);
  // props.children intentionally excluded: we only trigger on routeId changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.routeId, rm]);

  const isDimming = phase === 'dimming';

  return (
    <Box {...style} flexDirection="column" flexGrow={1} paddingX={1}>
      <Text color={isDimming ? semantic.textMuted : semantic.accent} bold>
        {props.title}
      </Text>
      {props.children}
    </Box>
  );
}
