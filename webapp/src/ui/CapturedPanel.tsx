import { useArtifactsSnapshot, type ArtifactsModel } from '../transport/artifacts.js';
import { SafeText } from './SafeText.js';

/**
 * The captured-items panel (7e S3) — the human's read surface for the clips/qa captured this session. It
 * mirrors the SERVER-authoritative ArtifactsModel (post-hello snapshot + live deltas) and renders each item's
 * title / url plus a trusted|untrusted badge. title and url are page-derived UNTRUSTED strings, so each goes
 * through SafeText (inert text) — a clip titled with markup can never inject. The badge reflects the host's
 * `trusted` flag verbatim (never re-derived on the client). The panel adds nothing optimistically; a row
 * appears only when the host sends it. Copy is capability language only.
 */
export interface CapturedPanelProps {
  model: ArtifactsModel;
}

export function CapturedPanel({ model }: CapturedPanelProps) {
  const items = useArtifactsSnapshot(model);
  return (
    <section class="studio-captured" aria-label="Captured items">
      <h2>Captured</h2>
      {items.length === 0 ? (
        <p class="studio-captured-empty">No captured items yet.</p>
      ) : (
        <ul class="studio-captured-list">
          {items.map((it) => (
            <li key={it.id} class="studio-captured-item" data-type={it.type}>
              <SafeText class="studio-captured-title" value={it.title} />
              <SafeText class="studio-captured-url" value={it.url} />
              <span class="studio-captured-trust" data-trusted={it.trusted}>
                {it.trusted ? 'trusted' : 'untrusted'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
