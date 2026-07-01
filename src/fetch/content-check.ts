const VISIBLE_TEXT_THRESHOLD = 200;
const SCRIPT_RATIO_THRESHOLD = 0.8;
// The body-substantive cutoff above which a defensive
// <noscript> or `enable JavaScript` marker is no longer load-bearing. Docs
// sites routinely ship a "please enable JS" <noscript> alongside fully SSR
// article bodies; the noscript marker alone was forcing Playwright on pages
// where HTTP returned everything the user needed.
const SUBSTANTIVE_BODY_THRESHOLD = 500;

function stripScriptsAndStyles(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

function extractVisibleText(html: string): string {
  const stripped = stripScriptsAndStyles(html);
  const noTags = stripped.replace(/<[^>]+>/g, ' ');
  return noTags.replace(/\s+/g, ' ').trim();
}

/**
 * Visible text with all `<noscript>` blocks excluded. Used by the SPA-shell
 * heuristic so a defensive `<noscript>You need to enable JavaScript</noscript>`
 * does not count toward the substantive-body score — we only want to know
 * what a non-JS reader actually sees in the real body.
 */
function extractVisibleTextExcludingNoscript(html: string): string {
  const withoutNoscript = html.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  return extractVisibleText(withoutNoscript);
}

function hasSpaShellIndicator(html: string): boolean {
  const emptyShell = [
    /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i,
    /<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i,
    /<div[^>]+id=["']__next["'][^>]*>\s*<\/div>/i,
  ];
  if (emptyShell.some((pattern) => pattern.test(html))) return true;

  // Non-empty root div but no semantic content: react.dev / nextjs.org SSR
  // a small nav skeleton into <div id="root"> yet ship the real article
  // content via client-side hydration. If a shell ID is present AND the page
  // lacks a <main>/<article> block, treat it as a SPA so the router escalates.
  const hasShellId = /<div[^>]+id=["'](?:root|app|__next)["']/i.test(html);
  if (!hasShellId) return false;
  const hasSemanticContent = /<main[\s>]|<article[\s>]/i.test(html);
  if (hasSemanticContent) return false;

  // If the shell-id is present but the surrounding body
  // already contains a substantive amount of visible prose (>= 500 chars,
  // excluding <noscript> warnings), don't escalate. The article is reachable
  // via HTTP even though the framework chose to wrap it in a #root/#app div.
  const visibleText = extractVisibleTextExcludingNoscript(html);
  return visibleText.length < SUBSTANTIVE_BODY_THRESHOLD;
}

function hasNextData(html: string): boolean {
  if (!/__NEXT_DATA__/.test(html)) return false;
  const withoutScripts = stripScriptsAndStyles(html);
  const visibleText = withoutScripts.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return visibleText.length < VISIBLE_TEXT_THRESHOLD;
}

/**
 * Only treat a `<noscript>` block as a JS-required
 * marker when:
 *   (a) the noscript text actually warns about JavaScript (the existing
 *       "javascript"/"enable" keyword check), AND
 *   (b) the rest of the body (excluding any noscript blocks) is below the
 *       substantive-body threshold.
 *
 * Pages that ship a defensive `<noscript>` alongside a fully SSR article
 * body — common on docs sites and CMS-rendered content — used to trip this
 * heuristic and force Playwright; with (b) we correctly stay on the HTTP
 * path because the article is reachable without JS.
 */
function hasNoscriptRequired(html: string): boolean {
  const noscriptMatches = html.match(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi);
  if (!noscriptMatches) return false;
  const looksLikeJsWarning = noscriptMatches.some((tag) => {
    const inner = tag.replace(/<[^>]+>/g, '').toLowerCase();
    return inner.includes('javascript') || inner.includes('enable');
  });
  if (!looksLikeJsWarning) return false;
  // (b) gate: ignore the marker when the body has substantive content.
  const bodyText = extractVisibleTextExcludingNoscript(html);
  return bodyText.length < SUBSTANTIVE_BODY_THRESHOLD;
}

function hasHighScriptRatio(html: string): boolean {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1] : html;

  const scriptMatches = bodyContent.match(/<script[\s\S]*?<\/script>/gi) ?? [];
  const scriptText = scriptMatches.join('');

  const scriptLen = scriptText.length;
  const totalLen = bodyContent.length;

  if (totalLen === 0) return false;
  return scriptLen / totalLen > SCRIPT_RATIO_THRESHOLD;
}

export function contentAppearsEmpty(html: string): boolean {
  const visibleText = extractVisibleText(html);
  if (visibleText.length < VISIBLE_TEXT_THRESHOLD) return true;

  if (hasSpaShellIndicator(html)) return true;
  if (hasNextData(html)) return true;
  if (hasNoscriptRequired(html)) return true;
  if (hasHighScriptRatio(html)) return true;

  return false;
}
