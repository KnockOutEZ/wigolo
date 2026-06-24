import { up, encodeUp, type ControlParty } from '../transport/codec.js';

/**
 * Control-handoff UI (S2). The human is the default driver; this surfaces the two human-initiated token
 * transitions — hand control to the agent (grant) and take it back (reclaim) — and emits each as a
 * {t:'control', op, to?} up-message THROUGH THE CODEC. It NEVER flips the who's-driving indicator locally:
 * the holder changes only when the host echoes a {t:'control'} down-message into the ControlsModel.
 *
 * Copy is capability language only (no implementation/dependency names).
 */
export interface ControlHandoffProps {
  /** The current SERVER-authoritative holder (drives which transition is offered). */
  holder: ControlParty;
  /** Send an encoded up-message to the host (real: StreamConnection.send). Never mutates local state. */
  onEmit: (wire: string) => void;
}

export function ControlHandoff({ holder, onEmit }: ControlHandoffProps) {
  const grant = () => onEmit(encodeUp(up.control('grant', 'agent')));
  const reclaim = () => onEmit(encodeUp(up.control('reclaim')));
  return (
    <div class="studio-handoff">
      {holder === 'human' ? (
        <button type="button" class="studio-handoff-grant" onClick={grant}>
          Hand control to the agent
        </button>
      ) : (
        <button type="button" class="studio-handoff-reclaim" onClick={reclaim}>
          Take back control
        </button>
      )}
    </div>
  );
}
