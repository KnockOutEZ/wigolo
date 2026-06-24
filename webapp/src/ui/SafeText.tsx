/**
 * SafeText (S1) — the shared rail trust primitive. Renders a page-derived string as INERT text: the value
 * becomes a JSX text child, so Preact emits it as a DOM text node and the browser never parses any markup it
 * contains into live elements. Page content (a mark's role/name) is UNTRUSTED DATA — it can be named
 * `<img src=x onerror=…>` — so every rail surface that shows such a string routes it through here rather than
 * setting innerHTML. There is no `dangerouslySetInnerHTML` path: that is the whole point of the primitive.
 */
export interface SafeTextProps {
  /** The untrusted, page-derived string to show. Rendered verbatim as text, never as markup. */
  value: string;
  /** Optional class for styling the wrapping inline element. */
  class?: string;
}

export function SafeText({ value, class: className }: SafeTextProps) {
  return <span class={className}>{value}</span>;
}
