/**
 * The browser side of the Studio token handshake (S2).
 *
 * The tab is opened with a one-time NONCE in its URL (`?n=…`) — never the bearer. The page redeems that
 * nonce for the session bearer over a loopback POST, strips the nonce from the visible URL, and from then
 * on presents the bearer ONLY via the WebSocket subprotocol — never in a URL/query (a URL leaks into
 * history, refresh, share, `Referer`). `buildStreamConnect` is the single place the stream URL + protocols
 * are constructed, so the "bearer never in the URL" invariant lives in one auditable function.
 */

const NONCE_PARAM = 'n';
const TOKEN_PATH = '/studio/token';
const STREAM_SUBPROTOCOL = 'wigolo.stream';
const BEARER_SUBPROTOCOL_PREFIX = 'wigolo.bearer.';

/** Read the one-time nonce the host put in the tab URL. */
export function readNonce(search: string = location.search): string | null {
  return new URLSearchParams(search).get(NONCE_PARAM);
}

export interface ExchangeDeps {
  fetch?: typeof fetch;
  /** Remove the nonce from the visible URL after a successful exchange (default: history.replaceState). */
  stripNonce?: () => void;
}

/** Redeem the nonce for the session bearer over loopback, then scrub the nonce from the URL. */
export async function exchangeNonceForToken(nonce: string, deps: ExchangeDeps = {}): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const resp = await doFetch(TOKEN_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  if (!resp.ok) throw new Error(`token exchange failed (${resp.status})`);
  const data = (await resp.json()) as { token?: unknown };
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new Error('token exchange returned no token');
  }
  (deps.stripNonce ?? defaultStripNonce)();
  return data.token;
}

function defaultStripNonce(): void {
  const url = new URL(location.href);
  url.searchParams.delete(NONCE_PARAM);
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

export interface StreamConnect {
  url: string;
  protocols: string[];
}

/**
 * Build the stream WebSocket target. PIN-S2a: the bearer is carried in the SUBPROTOCOL list ONLY; the URL
 * and its query carry NO token, ever.
 */
export function buildStreamConnect(sessionId: string, token: string, origin: string = location.origin): StreamConnect {
  const wsBase = origin.replace(/^http/, 'ws');
  return {
    url: `${wsBase}/studio/${encodeURIComponent(sessionId)}/stream`,
    protocols: [STREAM_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${token}`],
  };
}

/** Open the stream socket with the bearer presented via subprotocol (token-free URL). */
export function openStreamSocket(sessionId: string, token: string): WebSocket {
  const { url, protocols } = buildStreamConnect(sessionId, token);
  return new WebSocket(url, protocols);
}
