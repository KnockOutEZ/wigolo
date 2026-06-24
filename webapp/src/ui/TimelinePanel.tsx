import { useTimelineSnapshot, type TimelineModel } from '../transport/timeline.js';
import { SafeText } from './SafeText.js';

/**
 * The activity-timeline panel (7d S4) — the human's read surface for the audit trail (= the Phase-6b
 * append-only log). It mirrors the SERVER-authoritative TimelineModel (post-hello snapshot REPLACE + live
 * deltas APPEND) and renders each entry's action / outcome / risk / target / ts. action, outcome.error_reason
 * and target.url/ref are host-relayed but may echo page-derived content, so every such string goes through
 * SafeText (inert text) — a value carrying markup can never inject. The panel adds nothing optimistically; a
 * row appears only when the host sends it. Copy is capability language only.
 */
export interface TimelinePanelProps {
  model: TimelineModel;
}

export function TimelinePanel({ model }: TimelinePanelProps) {
  const entries = useTimelineSnapshot(model);
  return (
    <section class="studio-timeline" aria-label="Activity timeline">
      <h2>Activity</h2>
      {entries.length === 0 ? (
        <p class="studio-timeline-empty">No agent activity yet.</p>
      ) : (
        <ul class="studio-timeline-list">
          {entries.map((e) => (
            <li key={e.seq} class="studio-timeline-entry" data-ok={e.outcome.ok ? 'true' : 'false'}>
              <SafeText class="studio-timeline-action" value={e.action} />
              <SafeText class="studio-timeline-outcome" value={e.outcome.ok ? 'ok' : `failed: ${e.outcome.error_reason ?? ''}`} />
              {e.risk ? <SafeText class="studio-timeline-risk" value={e.risk} /> : null}
              {e.target?.url ? <SafeText class="studio-timeline-target" value={e.target.url} /> : null}
              {e.target?.ref ? <SafeText class="studio-timeline-target" value={e.target.ref} /> : null}
              <SafeText class="studio-timeline-ts" value={String(e.ts)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
