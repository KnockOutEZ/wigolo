import { useMemo } from 'preact/hooks';
import { ControlsModel } from '../transport/controls.js';
import { ControlsPanel } from './ControlsPanel.js';

/**
 * The side rail (S4). Its FIRST panel is the direct-drive controls (who's-driving + handoff + nav), wired to
 * the live connection's model + codec emit. Later phases fill the rest (marks, captures, timeline). With no
 * controls injected — the jsdom/no-op path — it renders an inert default model so mounting never needs a live
 * connection. Copy is capability language only.
 */
export interface RailControls {
  model: ControlsModel;
  emit: (wire: string) => void;
}

export interface RailProps {
  controls?: RailControls;
}

export function Rail({ controls }: RailProps = {}) {
  const c = useMemo<RailControls>(() => controls ?? { model: new ControlsModel(), emit: () => {} }, [controls]);
  return (
    <aside class="studio-rail" aria-label="Session panel">
      <ControlsPanel model={c.model} emit={c.emit} />
      <h2>Session</h2>
      <p class="studio-rail-empty">Marks, captures, and the activity timeline will appear here.</p>
    </aside>
  );
}
