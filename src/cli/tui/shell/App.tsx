import { Box } from 'ink';
import type { ReactNode } from 'react';
import { Header } from './Header.js';
import { Sidebar, type SidebarRoute } from './Sidebar.js';
import { MainPane } from './MainPane.js';
import { Footer, FooterProvider } from './Footer.js';

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
  dirtyByCategory: Record<string, number>;
  status: 'ok' | 'warn' | 'err';
  pending: number;
  toast: { message: string; severity: 'ok' | 'warn' | 'err' } | null;
  focusedPane: 'sidebar' | 'main';
  paneTitle: string;
  onSelectRoute: (id: string) => void;
  children: ReactNode;
}

export function App(props: AppProps): JSX.Element {
  const routes = props.routes ?? DEFAULT_ROUTES;
  return (
    <FooterProvider>
      <Box flexDirection="column" height="100%">
        <Header status={props.status} pending={props.pending} toast={props.toast} />
        <Box flexGrow={1}>
          <Sidebar
            routes={routes}
            activeRoute={props.activeRoute}
            dirtyByCategory={props.dirtyByCategory}
            onSelect={props.onSelectRoute}
            focused={props.focusedPane === 'sidebar'}
          />
          <MainPane title={props.paneTitle} focused={props.focusedPane === 'main'}>
            {props.children}
          </MainPane>
        </Box>
        <Footer />
      </Box>
    </FooterProvider>
  );
}
