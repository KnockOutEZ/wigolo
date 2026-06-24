import { useMemo } from 'preact/hooks';
import { ControlsModel } from '../transport/controls.js';
import { MarksModel } from '../transport/marks.js';
import { ControlsPanel } from './ControlsPanel.js';
import { MarksPanel } from './MarksPanel.js';

/**
 * The side rail (S4). Its FIRST panel is the direct-drive controls (who's-driving + handoff + nav); BELOW it
 * (7c) the marks-list read surface, both wired to the live connection's models + codec emit. Later phases
 * fill the rest (captures, timeline). With nothing injected — the jsdom/no-op path — it renders inert default
 * models so mounting never needs a live connection. Copy is capability language only.
 */
export interface RailControls {
  model: ControlsModel;
  emit: (wire: string) => void;
}

export interface RailProps {
  controls?: RailControls;
  marks?: MarksModel;
}

export function Rail({ controls, marks }: RailProps = {}) {
  const c = useMemo<RailControls>(() => controls ?? { model: new ControlsModel(), emit: () => {} }, [controls]);
  const m = useMemo<MarksModel>(() => marks ?? new MarksModel(), [marks]);
  return (
    <aside class="studio-rail" aria-label="Session panel">
      <ControlsPanel model={c.model} emit={c.emit} />
      <MarksPanel model={m} />
      <p class="studio-rail-empty">Captured items and the activity timeline will appear here.</p>
    </aside>
  );
}
