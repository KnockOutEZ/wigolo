import { useEffect, useState } from 'react';
import { parseOmnibox } from './omnibox-parse';
import { IconBack, IconForward, IconReload, IconGlobe, IconStar, IconLink, IconReader, IconSpark, IconClip } from './icons';

/**
 * The toolbar row: nav controls · a centered dual-mode omnibox pill (Enter = navigate/search) ·
 * verb cluster · the Agent-rail toggle. The `data-testid="omnibox"` input is preserved for e2e.
 */
export function Toolbar(props: {
  currentUrl: string;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  railOpen: boolean;
  onToggleRail: () => void;
  /** Arm region-clip on the focused session tab (✂ — same as ⌘⇧X). */
  onClip: () => void;
}) {
  const [text, setText] = useState(props.currentUrl);
  useEffect(() => setText(props.currentUrl), [props.currentUrl]);

  return (
    <div className="toolbar">
      <div className="navbtns">
        <button className="iconbtn" onClick={props.onBack} title="Back"><IconBack /></button>
        <button className="iconbtn" onClick={props.onForward} title="Forward"><IconForward /></button>
        <button className="iconbtn" onClick={props.onReload} title="Reload"><IconReload /></button>
      </div>

      <div className="omnibox">
        <span className="omnibox__lead"><IconGlobe /></span>
        <input
          data-testid="omnibox"
          className="omnibox__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) props.onNavigate(parseOmnibox(text)); }}
          placeholder="Search or type a URL — ⇥ to hand it to the agent"
          spellCheck={false}
        />
        <div className="omnibox__actions">
          <button className="iconbtn" title="Bookmark"><IconStar /></button>
          <button className="iconbtn" title="Copy link"><IconLink /></button>
          <button className="iconbtn" onClick={props.onClip} title="Clip a region (⌘⇧X)"><IconClip /></button>
          <button className="iconbtn" title="Reader"><IconReader /></button>
        </div>
      </div>

      <button
        className={`assistant-toggle${props.railOpen ? ' assistant-toggle--on' : ''}`}
        onClick={props.onToggleRail}
        title="Toggle the agent rail"
      >
        <IconSpark /> Agent
      </button>
    </div>
  );
}
