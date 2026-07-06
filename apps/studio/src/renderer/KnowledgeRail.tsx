import { useState } from 'react';
import type { KnowledgeHit } from '../shared/ipc';

/**
 * The ambient knowledge rail (spec §3) — one quiet expandable line at the rail's foot showing related
 * items from the local studio corpus (find_similar on the current page). Stays silent when nothing
 * relates, so it never nags.
 */
export function KnowledgeRail({ hits }: { hits: KnowledgeHit[] }) {
  const [open, setOpen] = useState(false);
  if (hits.length === 0) return null;
  return (
    <div className="knowledge">
      <button className="knowledge__line" onClick={() => setOpen((o) => !o)}>
        <span className="knowledge__caret">{open ? '▾' : '▸'}</span>
        {hits.length} related {hits.length === 1 ? 'item' : 'items'} in your library
      </button>
      {open && (
        <ul className="knowledge__hits">
          {hits.map((h, i) => (
            <li key={`${h.url}-${i}`} className="knowledge__hit">
              <a href={h.url} onClick={(e) => e.preventDefault()} title={h.url}>{h.title || h.url}</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
