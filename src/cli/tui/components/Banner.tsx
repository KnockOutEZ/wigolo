import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';
import { getPackageVersion } from '../version.js';

interface BannerProps {
  onComplete: () => void;
}

export function Banner({ onComplete }: BannerProps) {
  useEffect(() => {
    const timer = setTimeout(onComplete, 1500);
    return () => clearTimeout(timer);
  }, [onComplete]);

  const version = getPackageVersion();

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Gradient name="pastel">
        <BigText text="WIGOLO" font="tiny" />
      </Gradient>
      <Text dimColor>Local-first web intelligence for AI agents</Text>
      <Text dimColor>v{version}</Text>
    </Box>
  );
}
