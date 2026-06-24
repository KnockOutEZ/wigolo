import { useControlsSnapshot, type ControlsModel } from '../transport/controls.js';

/**
 * Who's-driving indicator (S1). Renders the current holder straight from the SERVER-authoritative
 * ControlsModel — never a local/optimistic guess — so the human always sees who the HOST says is driving.
 * Copy is capability language only (no implementation/dependency names).
 */
export interface DriveIndicatorProps {
  model: ControlsModel;
}

export function DriveIndicator({ model }: DriveIndicatorProps) {
  const { holder } = useControlsSnapshot(model);
  const label = holder === 'human' ? 'You are driving' : 'Agent is driving';
  return (
    <div class="studio-driving" data-holder={holder} role="status" aria-live="polite">
      {label}
    </div>
  );
}
