import type { TabInfo } from '../../src/shared/ipc';
import { IconClose } from './icons';

/** Derive a page-origin favicon glyph slot — a neutral initial when no favicon is known yet. */
function faviconInitial(t: TabInfo): string {
  try {
    const h = new URL(t.url).hostname.replace(/^www\./, '');
    return (h[0] ?? '·').toUpperCase();
  } catch {
    return '·';
  }
}

export function TabStrip(props: {
  tabs: TabInfo[];
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /**
   * Per-tab co-drive provenance. Two accent families only: `agent` is the agent hue, `working` is the
   * attention hue plus a pulse (an agent working in the background is the one that may want you), and
   * `human` is provenance rather than a state so it takes the neutral studio role.
   */
  provenance?: (id: string) => 'human' | 'agent' | 'working' | 'none';
}) {
  return (
    <div className="titlebar">
      {props.tabs.map((t) => (
        <div
          key={t.id}
          data-testid={`tab-${t.id}`}
          className={`tab${t.active ? ' tab--active' : ''}`}
          onClick={() => props.onFocus(t.id)}
          title={t.title || t.url}
        >
          {/* provenance dot when the agent/human has driven this tab; else the neutral favicon chip */}
          {(() => {
            const p = props.provenance?.(t.id) ?? 'none';
            if (p === 'none') {
              return <span className="tab__fav">{faviconInitial(t)}</span>;
            }
            const title = p === 'working' ? 'agent working in background' : p === 'agent' ? 'agent drove last' : 'you drove last';
            return <span className={`tab__dot tab__dot--${p}`} title={title} />;
          })()}
          <span className="tab__title">{t.title || t.url || 'New tab'}</span>
          <span
            data-testid={`close-${t.id}`}
            className="tab__close"
            onClick={(e) => { e.stopPropagation(); props.onClose(t.id); }}
          >
            <IconClose />
          </span>
        </div>
      ))}
      <button data-testid="new-tab" className="tab-new" onClick={props.onNew} title="New tab">+</button>
    </div>
  );
}
