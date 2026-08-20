import type { ChatMsgDto } from '../shared/ipc';

/**
 * The chat rail transcript (spec §3): the agent talks to the human via studio_say, the human replies in
 * the composer. Both are human language, so both render in the sans body voice — the studio chrome is
 * not rendered web content, which is the only place serif is allowed. Both render as inert text nodes
 * (React escapes) — page content the agent might quote can never execute or smuggle markup.
 */
export function ChatPanel({ messages }: { messages: ChatMsgDto[] }) {
  return (
    <div className="chat">
      {messages.map((m, i) => (
        <div key={`${m.ts}-${i}`} className={`chat__msg chat__msg--${m.author}`}>
          <div className="chat__author">{m.author === 'agent' ? 'Agent' : 'You'}</div>
          <div className="chat__text">{m.text}</div>
          {m.markId && <div className="chat__onmark">on mark {m.markId}</div>}
        </div>
      ))}
    </div>
  );
}
