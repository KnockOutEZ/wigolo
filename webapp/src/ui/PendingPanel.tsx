import { useParkedSnapshot, type ParkedModel } from '../transport/parked.js';
import { SafeText } from './SafeText.js';

/**
 * The pending-review panel (S7) — risky agent actions PARKED for the human because no pre-grant matched. The
 * human reviews them here (and can pre-authorize their class via the scope panel). Read-only. The page-derived
 * `domain` renders via SafeText (inert). Copy is capability language only.
 */
export interface PendingPanelProps {
  model: ParkedModel;
}

export function PendingPanel({ model }: PendingPanelProps) {
  const parked = useParkedSnapshot(model);
  // Render NOTHING when empty — like the approval card, this is an interrupt surface that appears only when
  // there is something to review, so the rail's default first panel stays the direct-drive controls.
  if (parked.length === 0) return null;
  return (
    <section class="studio-pending" aria-label="Pending review">
      <h2>Pending review</h2>
      <ul class="studio-pending-list">
        {parked.map((p, i) => (
          <li key={i} class="studio-pending-item">
            <span class="studio-pending-action">{p.action}</span>
            <span class="studio-pending-risk">{p.risk}</span>
            {p.domain ? <SafeText class="studio-pending-domain" value={p.domain} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
