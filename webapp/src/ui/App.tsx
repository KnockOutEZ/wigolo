import { BrowserPane } from './BrowserPane.js';
import { Rail } from './Rail.js';

/**
 * The Studio web-app root (S7): a split view of the live browser pane and the session rail. All user-facing
 * copy uses capability language only — never an implementation/dependency name (the served-UI guardrail).
 */
export interface AppProps {
  /** Forwarded to the browser pane so tests can render the split view without a live connection. */
  connect?: (canvas: HTMLCanvasElement) => () => void;
}

export function App({ connect }: AppProps = {}) {
  return (
    <div id="studio-root" class="studio-split">
      <header class="studio-header">
        <h1>wigolo studio</h1>
      </header>
      <div class="studio-body">
        <BrowserPane connect={connect} />
        <Rail />
      </div>
    </div>
  );
}
