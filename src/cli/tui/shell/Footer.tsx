import { Box, Text } from 'ink';
import { createContext, useCallback, useContext, useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { semantic } from '../theme/palette.js';

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
    if (!ctx) return;
    ctx.register(id, hints);
    return () => {
      ctx.unregister(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hintsKey]);
}

export function Footer(): JSX.Element {
  const ctx = useContext(FooterContext);
  const top = ctx ? Array.from(ctx.stack.values()).at(-1) ?? [] : [];
  return (
    <Box paddingX={1}>
      <Text color={semantic.textDim}>{top.join(' · ')}</Text>
    </Box>
  );
}
