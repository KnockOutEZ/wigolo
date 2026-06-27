import { useNarrationSnapshot, type NarrationModel } from '../transport/narration.js';
import { SafeText } from './SafeText.js';

/**
 * The narration panel (S2b) — the agent→human running commentary. The agent attaches an optional note to a
 * studio_act / studio_observe call; the host broadcasts it here. Read-only: there is NO input (the human's
 * channel is the comments panel). Each narration is AGENT-authored, so it is UNTRUSTED on this surface and
 * rendered via SafeText (inert text node, never markup) — that is the load-bearing guard against a
 * page→agent→narration→UI injection-laundering path. Copy is capability language only.
 */
export interface NarrationPanelProps {
  model: NarrationModel;
}

export function NarrationPanel({ model }: NarrationPanelProps) {
  const narrations = useNarrationSnapshot(model);
  return (
    <section class="studio-narration" aria-label="Agent narration">
      <h2>Agent narration</h2>
      {narrations.length === 0 ? (
        <p class="studio-narration-empty">No narration yet.</p>
      ) : (
        <ul class="studio-narration-list">
          {narrations.map((text, i) => (
            <li key={i} class="studio-narration-item">
              <SafeText class="studio-narration-text" value={text} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
