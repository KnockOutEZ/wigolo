import { useState } from 'react';
import type { Mark } from './marks-store';
import type { StudioGeneralizeOutput } from 'wigolo/studio';

const CONF_TITLE: Record<Mark['confidence'], string> = {
  high: 'Resolves confidently on the current page',
  medium: 'Resolves, but an attribute drifted — verify before acting',
  low: 'Ambiguous — the agent should ask, not guess',
  none: 'No longer found on the page',
};

/** The Marks rail pane: the human's marked elements — chip, confidence, comments, grab-all preview.
 * role/name are page-derived (untrusted) — rendered as inert text, never executed. */
export function MarksPanel(props: {
  marks: Mark[];
  preview: StudioGeneralizeOutput | null;
  onArm: () => void;
  onComment: (markId: string, text: string) => void;
  onGeneralize: (markId: string) => void;
}) {
  return (
    <div className="marks-panel">
      <button className="marks-arm" onClick={props.onArm}>◈ Mark an element</button>
      {props.marks.length === 0 && (
        <p className="rail__empty">
          Marking turns a page element into a durable, self-healing target the agent can act on.
          Press <b>◈ Mark an element</b> (or hold <b>⌥</b>), hover, and click. Scroll to grab the parent.
        </p>
      )}
      {props.marks.map((m) => (
        <MarkCard
          key={m.markId}
          mark={m}
          preview={props.preview && props.preview.markId === m.markId ? props.preview : null}
          onComment={(text) => props.onComment(m.markId, text)}
          onGeneralize={() => props.onGeneralize(m.markId)}
        />
      ))}
    </div>
  );
}

function MarkCard(props: {
  mark: Mark;
  preview: StudioGeneralizeOutput | null;
  onComment: (text: string) => void;
  onGeneralize: () => void;
}) {
  const [draft, setDraft] = useState('');
  const num = Number(props.mark.markId.replace(/^m/, '')) || 0;
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    props.onComment(text);
    setDraft('');
  };
  return (
    <div className="mark-card">
      <div className="mark-card__head">
        <span className="mark-chip">◈ {num}</span>
        <span className="mark-card__name">
          {props.mark.role} · <span className="mark-card__label">“{props.mark.name}”</span>
        </span>
        <span className={`mark-conf mark-conf--${props.mark.confidence}`} title={CONF_TITLE[props.mark.confidence]} />
      </div>
      {props.mark.comments.map((c, i) => (
        <div className="mark-comment" key={i}>{c}</div>
      ))}
      <div className="mark-card__row">
        <input
          className="mark-comment__input"
          value={draft}
          placeholder="Comment for the agent…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <button className="mark-card__grab" title="Preview the repeating set" onClick={props.onGeneralize}>⧉</button>
      </div>
      {props.preview && (
        <div className="mark-preview">
          {props.preview.refs.length} on page · confirm before the agent acts (preview only)
        </div>
      )}
    </div>
  );
}
