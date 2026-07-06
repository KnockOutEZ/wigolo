import type { CaptureDto } from '../shared/ipc';

/** The Captures rail pane — clips, quotes, and region screenshots saved into the local library. */
export function CapturesPanel({ captures }: { captures: CaptureDto[] }) {
  if (captures.length === 0) {
    return (
      <p className="rail__empty">
        Nothing captured yet. Select text and press <b>⌘⇧C</b> to save a quote, or the agent can save
        clips as it co-browses — everything lands in your local library, searchable later.
      </p>
    );
  }
  return (
    <ul className="caps">
      {captures.map((c) => (
        <li key={c.id} className="caps__item">
          <span className="caps__type">{c.type}</span>
          <span className="caps__title">{c.title || c.url || 'untitled'}</span>
          {c.url && (
            <a className="caps__url" href={c.url} onClick={(e) => e.preventDefault()}>{c.url}</a>
          )}
        </li>
      ))}
    </ul>
  );
}
