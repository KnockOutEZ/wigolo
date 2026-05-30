import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

export type ShellWidth = 'wide' | 'narrow' | 'tiny';

export function classifyWidth(cols: number): ShellWidth {
  if (cols >= 90) return 'wide';
  if (cols >= 60) return 'narrow';
  return 'tiny';
}

export function useShellWidth(): ShellWidth {
  const { stdout } = useStdout();
  const [w, setW] = useState(() => classifyWidth(stdout.columns));
  useEffect(() => {
    const onResize = () => setW(classifyWidth(stdout.columns));
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  return w;
}
