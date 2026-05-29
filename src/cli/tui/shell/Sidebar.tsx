import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { semantic } from '../theme/palette.js';

export interface SidebarRoute {
  id: string;
  label: string;
  group: 'settings' | 'actions';
}

export interface SidebarProps {
  routes: readonly SidebarRoute[];
  activeRoute: string;
  dirtyByCategory: Record<string, number>;
  onSelect: (id: string) => void;
  focused: boolean;
}

export function Sidebar({ routes, activeRoute, dirtyByCategory, onSelect, focused }: SidebarProps): JSX.Element {
  const [cursor, setCursor] = useState(() => Math.max(0, routes.findIndex(r => r.id === activeRoute)));

  useEffect(() => {
    const i = routes.findIndex(r => r.id === activeRoute);
    if (i >= 0) setCursor(i);
  }, [activeRoute, routes]);

  useInput((_input, key) => {
    if (!focused) return;
    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1));
    } else if (key.downArrow) {
      setCursor(c => Math.min(routes.length - 1, c + 1));
    } else if (key.return) {
      onSelect(routes[cursor]!.id);
    }
  }, { isActive: focused });

  const settingsRoutes = routes.filter(r => r.group === 'settings');
  const actionsRoutes = routes.filter(r => r.group === 'actions');

  const renderRow = (r: SidebarRoute, globalIndex: number) => {
    const isCursor = focused && globalIndex === cursor;
    const isActive = r.id === activeRoute;
    const dirty = r.group === 'settings' && (dirtyByCategory[r.id] ?? 0) > 0;
    return (
      <Box key={r.id} justifyContent="space-between">
        <Text color={isCursor || isActive ? semantic.accent : semantic.text} bold={isCursor}>
          {isCursor ? '▸ ' : '  '}{r.label}
        </Text>
        {dirty && <Text color={semantic.accent}>●</Text>}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" width={24} paddingX={1}>
      <Text color={semantic.textDim} bold>SETTINGS</Text>
      {settingsRoutes.map((r, i) => renderRow(r, i))}
      <Text color={semantic.textMuted}>────────────────────</Text>
      <Text color={semantic.textDim} bold>ACTIONS</Text>
      {actionsRoutes.map((r, i) => renderRow(r, settingsRoutes.length + i))}
    </Box>
  );
}
