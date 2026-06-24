import { useMemo } from 'preact/hooks';
import { BrowserPane } from './BrowserPane.js';
import { Rail, type RailControls } from './Rail.js';
import { bootstrapStudio } from '../transport/bootstrap.js';

/**
 * The Studio web-app root (S7 split view + S4 controls). It owns the single shared connection: one
 * `bootstrapStudio` feeds BOTH the browser pane (frames + input) and the rail's direct-drive controls
 * (server-authoritative model + codec emit). In jsdom/tests `bootstrapStudio` returns null, so the UI renders
 * inertly; both the canvas `connect` and the `controls` are injectable for explicit tests. All user-facing
 * copy uses capability language only (the served-UI guardrail).
 */
export interface AppProps {
  /** Override the canvas wiring (tests). Defaults to the shared bootstrap. */
  connect?: (canvas: HTMLCanvasElement) => () => void;
  /** Override the rail controls (tests). Defaults to the shared bootstrap. */
  controls?: RailControls;
}

export function App({ connect, controls }: AppProps = {}) {
  const boot = useMemo(() => bootstrapStudio(), []);
  const connectFn = connect ?? boot?.connectCanvas;
  const controlsObj = controls ?? boot?.controls;
  return (
    <div id="studio-root" class="studio-split">
      <header class="studio-header">
        <h1>wigolo studio</h1>
      </header>
      <div class="studio-body">
        <BrowserPane connect={connectFn} />
        <Rail controls={controlsObj} />
      </div>
    </div>
  );
}
