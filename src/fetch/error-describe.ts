// Translate a thrown fetch error into a stable, specific reason string.
// Node's undici surfaces "fetch failed" on the outer TypeError while the
// actual code (ENOTFOUND/ECONNREFUSED/etc.) hides on err.cause. Drill the
// chain so callers see what actually broke instead of a generic phrase.

interface DescribedError {
  reason: string;
  hint?: string;
}

const CODE_DESCRIPTIONS: Record<string, { reason: string; hint?: string }> = {
  ENOTFOUND: { reason: 'DNS resolution failed (ENOTFOUND)', hint: 'Check the domain name; the host could not be resolved' },
  ECONNREFUSED: { reason: 'Connection refused (ECONNREFUSED)', hint: 'Target host rejected the connection — server may be down or port closed' },
  ECONNRESET: { reason: 'Connection reset (ECONNRESET)', hint: 'Remote peer closed the connection mid-request — retry may succeed' },
  ETIMEDOUT: { reason: 'Connection timed out (ETIMEDOUT)', hint: 'Increase timeoutMs or check network reachability' },
  EAI_AGAIN: { reason: 'DNS lookup temporarily failed (EAI_AGAIN)', hint: 'DNS resolver issue — retry shortly' },
  EHOSTUNREACH: { reason: 'Host unreachable (EHOSTUNREACH)' },
  ENETUNREACH: { reason: 'Network unreachable (ENETUNREACH)' },
  CERT_HAS_EXPIRED: { reason: 'TLS certificate expired' },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: { reason: 'TLS chain verification failed' },
  SELF_SIGNED_CERT_IN_CHAIN: { reason: 'Self-signed TLS certificate in chain' },
};

function extractCode(err: unknown, depth = 0): string | null {
  if (!err || depth > 5) return null;
  if (typeof err !== 'object') return null;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && e.code) return e.code;
  if (e.cause) return extractCode(e.cause, depth + 1);
  return null;
}

export function describeFetchError(err: unknown): DescribedError {
  const code = extractCode(err);
  if (code && CODE_DESCRIPTIONS[code]) return CODE_DESCRIPTIONS[code];

  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { reason: 'Request timed out', hint: 'Increase timeoutMs or check network reachability' };
    }
    const msg = err.message;
    if (code) return { reason: `${msg} (${code})` };
    return { reason: msg || 'fetch failed' };
  }
  return { reason: String(err) };
}
