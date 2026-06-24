import { useState } from 'preact/hooks';
import { up, encodeUp } from '../transport/codec.js';

/**
 * Navigation URL bar (S3). The human types a URL and submits; the bar emits a {t:'nav', url} up-message
 * THROUGH THE CODEC and does nothing else — no client-side navigation, no direct-WS bypass. The host owns the
 * navigation guard (a human-initiated nav may reach localhost; the agent's may not), so there is deliberately
 * NO SSRF logic here. Copy is capability language only.
 */
export interface NavBarProps {
  /** Send an encoded up-message to the host (real: StreamConnection.send). */
  onEmit: (wire: string) => void;
}

export function NavBar({ onEmit }: NavBarProps) {
  const [url, setUrl] = useState('');
  const submit = (e: Event) => {
    e.preventDefault(); // never let the browser perform a native navigation
    const u = url.trim();
    if (!u) return;
    onEmit(encodeUp(up.nav(u)));
  };
  return (
    <form class="studio-nav" onSubmit={submit}>
      <input
        class="studio-nav-url"
        type="text"
        value={url}
        onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
        aria-label="Address"
        placeholder="Enter a URL to open"
      />
      <button type="submit" class="studio-nav-go">
        Go
      </button>
    </form>
  );
}
