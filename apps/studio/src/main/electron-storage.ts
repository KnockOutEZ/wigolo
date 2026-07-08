import type { StorageStateOut } from 'wigolo/studio';

/** The minimal Electron `Cookies` surface we use — injected so the mapping is testable without Electron. */
export interface CookieJar {
  get(filter: Record<string, never>): Promise<
    Array<{
      name: string;
      value: string;
      domain?: string;
      path?: string;
      secure?: boolean;
      httpOnly?: boolean;
      expirationDate?: number;
      sameSite?: string;
    }>
  >;
  set(details: {
    url: string;
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expirationDate?: number;
    sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  }): Promise<void>;
}

/** Evaluate JS in the live page and return the parsed result (the wc.executeJavaScript seam). READ-only use. */
export type PageEval = <T = unknown>(code: string) => Promise<T>;

type PwCookie = StorageStateOut['cookies'][number];

const READ_LOCAL_STORAGE = `(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k != null) o[k] = localStorage.getItem(k); } return o; })()`;

/** Electron sameSite ('no_restriction'|'lax'|'strict'|'unspecified') → Playwright ('None'|'Lax'|'Strict'). */
function toPwSameSite(s: string | undefined): PwCookie['sameSite'] {
  switch (s) {
    case 'strict':
      return 'Strict';
    case 'lax':
      return 'Lax';
    case 'no_restriction':
      return 'None';
    default:
      return 'Lax';
  }
}

/** Playwright sameSite → Electron. */
function toElectronSameSite(s: PwCookie['sameSite']): 'no_restriction' | 'lax' | 'strict' {
  switch (s) {
    case 'Strict':
      return 'strict';
    case 'None':
      return 'no_restriction';
    default:
      return 'lax';
  }
}

/**
 * READ the Electron session's cookies + the current origin's localStorage into a Playwright-shaped
 * StorageStateOut. HOST-ONLY: never agent-facing, never logged — it carries the session cookies.
 */
export async function readStorageState(
  cookies: CookieJar,
  evalPage: PageEval,
  currentUrl: string | undefined,
): Promise<StorageStateOut> {
  const raw = await cookies.get({});
  const pwCookies: PwCookie[] = raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain ?? '',
    path: c.path ?? '/',
    expires: typeof c.expirationDate === 'number' ? c.expirationDate : -1,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: toPwSameSite(c.sameSite),
  }));

  let originStr: string | undefined;
  try {
    originStr = currentUrl ? new URL(currentUrl).origin : undefined;
  } catch {
    originStr = undefined;
  }

  const origins: StorageStateOut['origins'] = [];
  if (originStr) {
    let ls: Record<string, string> = {};
    try {
      ls = (await evalPage<Record<string, string>>(READ_LOCAL_STORAGE)) ?? {};
    } catch {
      ls = {};
    }
    const entries = Object.entries(ls).map(([name, value]) => ({ name, value }));
    if (entries.length > 0) origins.push({ origin: originStr, localStorage: entries });
  }
  return { cookies: pwCookies, origins };
}

function cookieUrl(c: PwCookie): string {
  const host = (c.domain ?? '').replace(/^\./, '');
  const scheme = c.secure ? 'https' : 'http';
  return `${scheme}://${host}${c.path || '/'}`;
}

/**
 * RESTORE a StorageStateOut's COOKIES into an Electron session (auth-critical; run pre-nav). localStorage is
 * NOT restored (D-P5-8 — the pre-nav page is an opaque about:blank origin). Never rejects — a per-cookie
 * failure is swallowed (fail-open on RESTORE only; the human can re-login).
 */
export async function applyStorageState(cookies: CookieJar, state: StorageStateOut): Promise<void> {
  for (const c of state.cookies ?? []) {
    try {
      await cookies.set({
        url: cookieUrl(c),
        name: c.name,
        value: c.value,
        domain: c.domain || undefined,
        path: c.path || '/',
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        ...(c.expires && c.expires > 0 ? { expirationDate: c.expires } : {}),
        sameSite: toElectronSameSite(c.sameSite),
      });
    } catch {
      /* best-effort restore — a bad cookie must not strand the session */
    }
  }
}
