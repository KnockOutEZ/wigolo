import { Box } from 'ink';
import type { ReactNode } from 'react';
import { Header } from './Header.js';
import { Sidebar, type SidebarRoute } from './Sidebar.js';
import { MainPane } from './MainPane.js';
import { Footer, FooterProvider } from './Footer.js';
import { CommandPalette } from './CommandPalette.js';
import { HelpOverlay } from './HelpOverlay.js';
import type { PaletteEntry } from './palette-index.js';
import type { ActivityStore } from '../state/activity-store.js';
import { useShellWidth } from './width.js';

export const DEFAULT_ROUTES: readonly SidebarRoute[] = [
  { id: 'browser',   label: 'Browser',       group: 'settings' },
  { id: 'search',    label: 'Search engine', group: 'settings' },
  { id: 'llm',       label: 'LLM provider',  group: 'settings' },
  { id: 'agents',    label: 'Agents',        group: 'settings' },
  { id: 'cache',     label: 'Cache',         group: 'settings' },
  { id: 'advanced',  label: 'Advanced',      group: 'settings' },
  { id: 'verify',    label: 'Verify',        group: 'actions'  },
  { id: 'doctor',    label: 'Doctor',        group: 'actions'  },
  { id: 'export',    label: 'Export',        group: 'actions'  },
  { id: 'import',    label: 'Import',        group: 'actions'  },
  { id: 'uninstall', label: 'Uninstall',     group: 'actions'  },
];

interface AppProps {
  routes?: readonly SidebarRoute[];
  activeRoute: string;
  /**
   * Full view discriminator for MainPane transitions (e.g. 'home', 'category:browser',
   * 'action:verify'). When omitted, falls back to activeRoute for backwards compat.
   */
  routeId?: string;
  dirtyByCategory: Record<string, number>;
  status: 'ok' | 'warn' | 'err';
  pending: number;
  toast: { message: string; severity: 'ok' | 'warn' | 'err' } | null;
  focusedPane: 'sidebar' | 'main';
  paneTitle: string;
  onSelectRoute: (id: string) => void;
  children: ReactNode;
  paletteOpen?: boolean;
  paletteEntries?: PaletteEntry[];
  onPalettePick?: (entry: PaletteEntry) => void;
  onPaletteClose?: () => void;
  helpOpen?: boolean;
  onHelpClose?: () => void;
  activityStore?: ActivityStore;
}

function computeBreadcrumb(routeId: string | undefined, routes: readonly SidebarRoute[], paneTitle: string): string {
  const rid = routeId ?? 'home';
  if (rid === 'home') return 'Home';
  if (rid.startsWith('category:')) {
    return `Settings › ${paneTitle}`;
  }
  if (rid.startsWith('action:')) {
    return `Actions › ${paneTitle}`;
  }
  const route = routes.find((r) => r.id === rid);
  if (route) {
    const prefix = route.group === 'settings' ? 'Settings' : 'Actions';
    return `${prefix} › ${route.label}`;
  }
  return paneTitle;
}

export function App(props: AppProps): JSX.Element {
  const routes = props.routes ?? DEFAULT_ROUTES;
  const width = useShellWidth();
  // breadcrumb only rendered when Header detects non-wide width; skip compute in wide mode
  const breadcrumb = width === 'wide' ? undefined : computeBreadcrumb(props.routeId, routes, props.paneTitle);
  return (
    <FooterProvider>
      <Box flexDirection="column" height="100%">
        <Header
          status={props.status}
          pending={props.pending}
          toast={props.toast}
          activityStore={props.activityStore}
          width={width}
          breadcrumb={breadcrumb}
        />
        <Box flexGrow={1}>
          {width === 'wide' && (
            <Sidebar
              routes={routes}
              activeRoute={props.activeRoute}
              dirtyByCategory={props.dirtyByCategory}
              onSelect={props.onSelectRoute}
              focused={props.focusedPane === 'sidebar'}
            />
          )}
          <MainPane title={props.paneTitle} focused={props.focusedPane === 'main'} routeId={props.routeId ?? props.activeRoute}>
            {props.children}
          </MainPane>
        </Box>
        <Footer width={width} />
        {props.paletteOpen && props.paletteEntries && props.onPalettePick && props.onPaletteClose && (
          <Box position="absolute" marginLeft={4} marginTop={2}>
            <CommandPalette
              entries={props.paletteEntries}
              onPick={props.onPalettePick}
              onClose={props.onPaletteClose}
            />
          </Box>
        )}
        {props.helpOpen && props.onHelpClose && (
          <Box position="absolute" marginLeft={4} marginTop={2}>
            <HelpOverlay onClose={props.onHelpClose} />
          </Box>
        )}
      </Box>
    </FooterProvider>
  );
}
