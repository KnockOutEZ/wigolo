import type { CaptureDto } from '../shared/ipc';
import type { ResearchBriefDto } from 'wigolo/studio';
import { BriefPanel } from './BriefPanel';

interface CapturesPanelProps {
  captures: CaptureDto[];
  /** P6 F3 — fire cross-tab synthesis over this session's captures (foot button). Absent ⇒ no button. */
  onSynthesize?: () => void;
  synthesizing?: boolean;
  brief?: ResearchBriefDto | null;
}

/** The Captures rail pane — clips, quotes, and region screenshots saved into the local library, plus the
 *  cross-tab "Synthesize session" action (P6 F3) that shapes them into a single cited brief. */
export function CapturesPanel({ captures, onSynthesize, synthesizing, brief }: CapturesPanelProps) {
  return (
    <>
      {captures.length === 0 ? (
        <p className="rail__empty">
          Nothing captured yet. Select text and press <b>⌘⇧C</b> to save a quote, or the agent can save
          clips as it co-browses — everything lands in your local library, searchable later.
        </p>
      ) : (
        <ul className="caps">
          {captures.map((c) => (
            <li key={c.id} className={`caps__item${c.type === 'extraction' ? ' caps__item--extraction' : ''}`}>
              <span className="caps__type">{c.type === 'extraction' ? 'grab-all' : c.type}</span>
              {/* For an extraction the title is host-derived counts ("N rows · M columns"); no page-derived
                  cell/column text is rendered in the rail (safest-by-construction — nothing to neutralize here). */}
              <span className="caps__title">{c.title || c.url || 'untitled'}</span>
              {c.url && (
                <a className="caps__url" href={c.url} onClick={(e) => e.preventDefault()}>{c.url}</a>
              )}
            </li>
          ))}
        </ul>
      )}
      {onSynthesize && (
        <div className="caps__synth">
          <button className="caps__synth-btn" disabled={synthesizing || captures.length === 0} onClick={onSynthesize}>
            {synthesizing ? 'Synthesizing…' : 'Synthesize session'}
          </button>
          <BriefPanel result={brief ?? null} />
        </div>
      )}
    </>
  );
}
