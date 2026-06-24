import { useControlsSnapshot, type ControlsModel } from '../transport/controls.js';
import { DriveIndicator } from './DriveIndicator.js';
import { ControlHandoff } from './ControlHandoff.js';
import { NavBar } from './NavBar.js';

/**
 * The direct-drive controls panel (S4): the who's-driving indicator, the control handoff, and the nav URL
 * bar, all bound to ONE server-authoritative ControlsModel and ONE codec emit. The panel passes `emit`
 * straight through to its children — it NEVER flips the holder locally, so the indicator reflects only what
 * the host echoes back (no optimistic flip). Copy is capability language only.
 */
export interface ControlsPanelProps {
  /** The server-authoritative control state (fed by the connection's hello/control messages). */
  model: ControlsModel;
  /** Send an encoded up-message to the host (real: StreamConnection.send). */
  emit: (wire: string) => void;
}

export function ControlsPanel({ model, emit }: ControlsPanelProps) {
  const { holder } = useControlsSnapshot(model);
  return (
    <section class="studio-controls" aria-label="Session controls">
      <DriveIndicator model={model} />
      <ControlHandoff holder={holder} onEmit={emit} />
      <NavBar onEmit={emit} />
    </section>
  );
}
