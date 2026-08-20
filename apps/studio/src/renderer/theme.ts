import { DEFAULT_REGISTER, REGISTER_ATTR, tokenCss, type Register } from './tokens';

/**
 * Installs the token layer into a document and switches its register at runtime.
 *
 * The switch is an attribute write on `<html>`, so a register change repaints against already-parsed
 * declarations: no navigation, no reload, no remount, and every open surface changes at once. That
 * matters beyond taste — a run outlives the UI looking at it, so a theme change must never be a
 * reason to reload a window that is currently driving a tab.
 *
 * The stylesheet is generated from `tokens.ts` rather than shipped as CSS so there is exactly one
 * place a token is defined. `installTokens` is idempotent: it rewrites the one style element it owns.
 */

const STYLE_ID = 'wigolo-tokens';

export function installTokens(doc: Document = document): HTMLStyleElement {
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    // First child of <head>: the token layer has to be parsed before any stylesheet that resolves
    // against it, and it must lose to nothing — its declarations are the floor, not an override.
    doc.head.insertBefore(style, doc.head.firstChild);
  }
  style.textContent = tokenCss();
  if (!doc.documentElement.getAttribute(REGISTER_ATTR)) {
    doc.documentElement.setAttribute(REGISTER_ATTR, DEFAULT_REGISTER);
  }
  return style;
}

export function currentRegister(doc: Document = document): Register {
  return doc.documentElement.getAttribute(REGISTER_ATTR) === 'light' ? 'light' : DEFAULT_REGISTER;
}

export function setRegister(register: Register, doc: Document = document): void {
  doc.documentElement.setAttribute(REGISTER_ATTR, register);
}

/**
 * The register the OS is asking for.
 *
 * `prefers-color-scheme` is the honest source: the studio is a browser, and a browser that ignores
 * the system appearance is the odd one out on the desktop. An explicit `setRegister` overrides it
 * until the system changes again.
 */
export function systemRegister(view: Window = window): Register {
  return view.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Track the system register live. Returns an unsubscribe. */
export function followSystemRegister(view: Window = window, doc: Document = document): () => void {
  const query = view.matchMedia?.('(prefers-color-scheme: light)');
  if (!query) return () => {};
  const onChange = (event: MediaQueryListEvent | MediaQueryList): void => {
    setRegister(event.matches ? 'light' : 'dark', doc);
  };
  onChange(query);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
