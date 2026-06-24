import { useMarksSnapshot, type MarksModel } from '../transport/marks.js';
import { SafeText } from './SafeText.js';

/**
 * The marks-list panel (7c S4) — the human's read surface for the elements they've marked. It mirrors the
 * SERVER-authoritative MarksModel (post-hello snapshot + live deltas) and renders each mark's markId / role /
 * name / confidence. role and name are page-derived UNTRUSTED strings, so every one goes through SafeText
 * (inert text) — a mark named with markup can never inject. The panel adds nothing optimistically; a row
 * appears only when the host sends it. Copy is capability language only.
 */
export interface MarksPanelProps {
  model: MarksModel;
}

export function MarksPanel({ model }: MarksPanelProps) {
  const marks = useMarksSnapshot(model);
  return (
    <section class="studio-marks" aria-label="Marked elements">
      <h2>Marks</h2>
      {marks.length === 0 ? (
        <p class="studio-marks-empty">No marked elements yet.</p>
      ) : (
        <ul class="studio-marks-list">
          {marks.map((m) => (
            <li key={m.markId} class="studio-mark" data-confidence={m.confidence}>
              <SafeText class="studio-mark-id" value={m.markId} />
              <SafeText class="studio-mark-role" value={m.role} />
              <SafeText class="studio-mark-name" value={m.name} />
              <SafeText class="studio-mark-confidence" value={m.confidence} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
