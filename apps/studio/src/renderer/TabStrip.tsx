import type { TabInfo } from '../../src/shared/ipc';

export function TabStrip(props: {
  tabs: TabInfo[];
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 40, background: '#ececf1', padding: '0 8px' }}>
      {props.tabs.map((t) => (
        <div
          key={t.id}
          data-testid={`tab-${t.id}`}
          onClick={() => props.onFocus(t.id)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', cursor: 'default',
            background: t.active ? '#fff' : 'transparent', borderRadius: '8px 8px 0 0', maxWidth: 200,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
            {t.title || t.url || 'New tab'}
          </span>
          <span
            data-testid={`close-${t.id}`}
            onClick={(e) => { e.stopPropagation(); props.onClose(t.id); }}
            style={{ fontSize: 11, color: '#888' }}
          >
            ×
          </span>
        </div>
      ))}
      <span data-testid="new-tab" onClick={props.onNew} style={{ padding: '4px 10px', color: '#666' }}>+</span>
    </div>
  );
}
