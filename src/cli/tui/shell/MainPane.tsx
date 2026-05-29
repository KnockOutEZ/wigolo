import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { borders } from '../theme/borders.js';
import { semantic } from '../theme/palette.js';

export function MainPane(props: {
  title: string;
  focused: boolean;
  children: ReactNode;
}): JSX.Element {
  const style = props.focused ? borders.active : borders.box;
  return (
    <Box {...style} flexDirection="column" flexGrow={1} paddingX={1}>
      <Text color={semantic.accent} bold>{props.title}</Text>
      {props.children}
    </Box>
  );
}
