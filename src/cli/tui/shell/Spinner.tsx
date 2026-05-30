import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { spinner } from '../theme/motion.js';
import { reducedMotion } from '../theme/motion-guard.js';

export function Spinner(): JSX.Element {
  const rm = reducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (rm) return;
    const t = setInterval(() => setI((x) => (x + 1) % spinner.dots.length), 80);
    return () => clearInterval(t);
  }, [rm]);
  return <Text>{rm ? '…' : spinner.dots[i]}</Text>;
}
