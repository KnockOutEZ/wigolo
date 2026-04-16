import React from 'react';
import { Box, Text } from 'ink';

export function Summary() {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="green"
        paddingX={2}
        paddingY={1}
      >
        <Text color="green" bold>{'✓'} Setup complete!</Text>
        <Text> </Text>
        <Text bold>Try it now:</Text>
        <Text>  Open Claude Code and ask:</Text>
        <Text color="cyan">  {'"Search for Next.js authentication setup"'}</Text>
        <Text> </Text>
        <Text bold>Commands:</Text>
        <Text>  <Text color="cyan">wigolo doctor</Text>    system diagnostics</Text>
        <Text>  <Text color="cyan">wigolo shell</Text>     interactive REPL</Text>
        <Text>  <Text color="cyan">wigolo status</Text>    quick health check</Text>
        <Text>  <Text color="cyan">wigolo init</Text>      re-run this setup</Text>
        <Text> </Text>
        <Text dimColor>Docs: https://github.com/KnockOutEZ/wigolo</Text>
      </Box>
    </Box>
  );
}
