/**
 * Pure marking-overlay helpers, isolated from the DOM-event / IPC wiring in overlay.ts so the
 * logic (path encoding, ancestor-walk, payload capture) is unit-testable under jsdom. All fields
 * captured here are PAGE-DERIVED and untrusted — the host neutralizes display strings before they
 * cross to the agent. Element-child indexing mirrors core resolveNodePath exactly (light-DOM only).
 */

export interface MarkPayload {
  tag: string;
  id: string;
  classes: string[];
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  text: string; // trimmed, capped
  component: string | null; // best-effort framework component name
  source: { file: string; line: number } | null; // best-effort sourcemap hint
}

const TEXT_CAP = 200;
const LABEL_CAP = 40;

/** Element-child indices from documentElement down to `el` (text/comment nodes skipped, matching resolveNodePath). */
export function elementPath(el: Element): number[] {
  const path: number[] = [];
  let cur: Element = el;
  const root = cur.ownerDocument?.documentElement;
  while (cur && root && cur !== root) {
    const parent = cur.parentElement;
    if (!parent) break;
    const idx = Array.prototype.indexOf.call(parent.children, cur);
    if (idx < 0) break;
    path.unshift(idx);
    cur = parent;
  }
  return path;
}

/** The whisker label: `tag.firstClass · "text"` (spec §4 State 1). */
export function whiskerLabel(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = el.classList[0] ? '.' + el.classList[0] : '';
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, LABEL_CAP);
  return text ? `${tag}${cls} · "${text}"` : `${tag}${cls}`;
}

/** ⇧/scroll ancestor climb; floors at documentElement (never past root). */
export function ancestorWalk(el: Element, dir: 'up'): Element {
  if (dir === 'up') {
    return el.parentElement && el !== el.ownerDocument.documentElement ? el.parentElement : el;
  }
  return el;
}

/** Best-effort React fiber / dev-source detection; degrades to null (never throws). */
function detectComponent(el: Element): { component: string | null; source: MarkPayload['source'] } {
  try {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!key) return { component: null, source: null };
    let fiber = (el as unknown as Record<string, unknown>)[key] as
      | { type?: unknown; _debugSource?: { fileName?: string; lineNumber?: number }; return?: unknown }
      | undefined;
    let component: string | null = null;
    let source: MarkPayload['source'] = null;
    for (let i = 0; fiber && i < 12; i++) {
      const t = fiber.type as { displayName?: string; name?: string } | string | undefined;
      if (t && typeof t !== 'string' && (t.displayName || t.name)) component = t.displayName ?? t.name ?? null;
      const ds = fiber._debugSource;
      if (ds?.fileName && typeof ds.lineNumber === 'number') source = { file: ds.fileName, line: ds.lineNumber };
      if (component) break;
      fiber = fiber.return as typeof fiber;
    }
    return { component, source };
  } catch {
    return { component: null, source: null };
  }
}

export function serializePayload(el: Element): MarkPayload {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  const dataset: Record<string, string> = {};
  if (el instanceof HTMLElement) {
    for (const [k, v] of Object.entries(el.dataset)) if (v !== undefined) dataset[k] = v;
  }
  const { component, source } = detectComponent(el);
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id ?? '',
    classes: Array.from(el.classList),
    attrs,
    dataset,
    text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, TEXT_CAP),
    component,
    source,
  };
}
