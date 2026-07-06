import { useEffect, useState } from 'react';
import { parseOmnibox } from './omnibox-parse';

export function Omnibox(props: { currentUrl: string; onNavigate: (url: string) => void }) {
  const [text, setText] = useState(props.currentUrl);
  useEffect(() => setText(props.currentUrl), [props.currentUrl]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 48, padding: '0 10px', background: '#fff', borderBottom: '1px solid #e5e5e5' }}>
      <input
        data-testid="omnibox"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) props.onNavigate(parseOmnibox(text)); }}
        placeholder="Search or enter address"
        style={{ flex: 1, background: '#f3f3f5', border: 'none', borderRadius: 14, padding: '7px 14px', font: '13px system-ui', outline: 'none' }}
      />
    </div>
  );
}
