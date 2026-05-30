import { Box, Text } from 'ink';
import { createContext, useCallback, useContext, useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { semantic } from '../theme/palette.js';
import type { ShellWidth } from './width.js';

type Hints = readonly string[];

interface FooterContextValue {
  register: (id: string, hints: Hints) => void;
  unregister: (id: string) => void;
  stack: Map<string, Hints>;
}

const FooterContext = createContext<FooterContextValue | null>(null);

export function FooterProvider({ children }: { children: ReactNode }): JSX.Element {
  const [stack, setStack] = useState<Map<string, Hints>>(() => new Map());

  const register = useCallback((id: string, hints: Hints) => {
    setStack((prev) => {
      const next = new Map(prev);
      next.set(id, hints);
      return next;
    });
  }, []);

  const unregister = useCallback((id: string) => {
    setStack((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  return (
    <FooterContext.Provider value={{ register, unregister, stack }}>
      {children}
    </FooterContext.Provider>
  );
}

export function useFooterHints(hints: Hints): void {
  const ctx = useContext(FooterContext);
  const id = useId();
  const hintsKey = hints.join('|');

  useEffect(() => {
    if (!ctx) {
      if (process.env.NODE_ENV !== 'production' && hints.length > 0) {
        process.stderr.write(
          `useFooterHints called outside FooterProvider; hints dropped: ${hints.join(' · ')}\n`
        );
      }
      return;
    }
    ctx.register(id, hints);
    return () => {
      ctx.unregister(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hintsKey]);
}

export function Footer({ width }: { width?: ShellWidth }): JSX.Element {
  const ctx = useContext(FooterContext);
  const top = ctx ? Array.from(ctx.stack.values()).at(-1) ?? [] : [];

  if (width === 'tiny' && top.length > 0) {
    const mid = Math.ceil(top.length / 2);
    const firstLine = top.slice(0, mid);
    const secondLine = top.slice(mid);
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={semantic.textDim}>{firstLine.join(' · ')}</Text>
        {secondLine.length > 0 && <Text color={semantic.textDim}>{secondLine.join(' · ')}</Text>}
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text color={semantic.textDim}>{top.join(' · ')}</Text>
    </Box>
  );
}
