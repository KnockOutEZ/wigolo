/**
 * THE token layer. One definition, two registers.
 *
 * `DESIGN_SYSTEM.md` §3 (dark) and §11 (light) are the same system re-anchored: geometry, type,
 * spacing, radii and components are identical between registers and only the ground and the accent
 * lightness move. So the shape that fits is one entry per token carrying BOTH values — not two
 * stylesheets, and not two `:root` blocks a contributor has to remember to edit in pairs. Adding a
 * token is one line here; it appears in both registers or in neither.
 *
 * Names are the ones `DESIGN_SYSTEM.md` uses. Where the document names a token by its role rather
 * than by a `--custom-property` (the text alphas, the type scale, radii, spacing, elevation), the
 * role is the name: `.72 body` becomes `--text-body`, `12 standard card` becomes `--radius-card`.
 * Where the document gives a range (`--agent-tint  … / .06 … .10`) both endpoints exist, the plain
 * name being the low end and `-strong` the high one.
 *
 * Nothing in here is invented. A value that is not in §3 or §11 does not belong in this file, and a
 * component that hard-codes a colour instead of resolving one of these is a bug in one register.
 */

export type Register = 'dark' | 'light';

export const REGISTERS: readonly Register[] = ['dark', 'light'];

export interface TokenDef {
  /** The custom-property name, including the leading `--`. */
  readonly name: string;
  /** Value in the dark register (`DESIGN_SYSTEM.md` §3). */
  readonly dark: string;
  /** Value in the light register (§11). Equal to `dark` for the register-independent tokens. */
  readonly light: string;
}

/** A token whose value is register-independent — §11: geometry, type, spacing and radii are identical. */
function fixed(name: string, value: string): TokenDef {
  return { name, dark: value, light: value };
}

/** A token that re-anchors between registers. */
function swap(name: string, dark: string, light: string): TokenDef {
  return { name, dark, light };
}

const AGENT_DARK = 'oklch(0.8 0.06 250)';
const AGENT_LIGHT = 'oklch(0.5 0.13 250)';
const ATTENTION_DARK = 'oklch(0.78 0.09 60)';
const ATTENTION_LIGHT = 'oklch(0.58 0.15 52)';

/** Relative-colour helper: the doc writes tints and edges as an alpha on the accent itself. */
function alpha(base: string, a: string): string {
  return `${base.slice(0, -1)} / ${a})`;
}

export const TOKENS: readonly TokenDef[] = [
  // ── Surfaces (§3 Surfaces, §11 Surfaces) ────────────────────────────────────────────────────
  swap('--bg', '#000', '#f6f5f2'),
  // §11 names `--surface-window`; §3's window component is `background:#000`, so the dark value is
  // the page ground itself rather than a second near-black.
  swap('--surface-window', '#000', '#fff'),
  swap('--surface-panel', '#060606', '#f4f3ef'),
  swap('--surface-tile', '#080808', '#fff'),
  // §11 only. Dark's equivalent is the window ground carrying `--page-hatch` on top (§3 Textures),
  // which is why the dark value is the ground and not a distinct fill.
  swap('--surface-mock', '#000', '#eeece7'),
  // Deliberately NOT inverted: §11 keeps terminals dark so machine output has one appearance in
  // both registers and the light UI gets an anchor.
  swap('--surface-term', '#070707', '#16171b'),
  fixed('--surface-page', '#fff'),

  // ── Lines (§3 Lines, §11 Lines) ─────────────────────────────────────────────────────────────
  // §11: invert the channel, do not reuse the numbers.
  swap('--hair', 'rgba(255,255,255,.12)', 'rgba(0,0,0,.14)'),
  swap('--hair-soft', 'rgba(255,255,255,.08)', 'rgba(0,0,0,.10)'),
  swap('--hair-faint', 'rgba(255,255,255,.07)', 'rgba(0,0,0,.09)'),
  swap('--hair-dash', 'rgba(255,255,255,.14)', 'rgba(0,0,0,.16)'),
  // §3: all borders are exactly 1px. No 2px borders, no double borders.
  fixed('--hair-width', '1px'),

  // ── Text (§3 Text, §11 Lines & text) ────────────────────────────────────────────────────────
  // §11: the strongest light ink is `#141414`, never `#000`.
  swap('--text-primary', 'rgba(255,255,255,.95)', '#141414'),
  swap('--text-emphasis', 'rgba(255,255,255,.85)', 'rgba(0,0,0,.8)'),
  swap('--text-body', 'rgba(255,255,255,.72)', 'rgba(0,0,0,.68)'),
  swap('--text-secondary', 'rgba(255,255,255,.62)', 'rgba(0,0,0,.6)'),
  swap('--text-label', 'rgba(255,255,255,.5)', 'rgba(0,0,0,.5)'),
  swap('--text-mono-muted', 'rgba(255,255,255,.5)', 'rgba(0,0,0,.46)'),
  swap('--text-mono', 'rgba(255,255,255,.42)', 'rgba(0,0,0,.46)'),
  swap('--text-micro', 'rgba(255,255,255,.36)', 'rgba(0,0,0,.42)'),
  swap('--text-hint', 'rgba(255,255,255,.3)', 'rgba(0,0,0,.38)'),
  swap('--text-placeholder', 'rgba(255,255,255,.24)', 'rgba(0,0,0,.3)'),

  // ── Accents (§3 Accents, §11 Accents) ───────────────────────────────────────────────────────
  // Two families, each meaning one thing. Agent = agent identity and agent-caused state.
  swap('--agent', AGENT_DARK, AGENT_LIGHT),
  swap('--agent-text', 'oklch(0.88 0.04 250)', 'oklch(0.4 0.14 250)'),
  swap('--agent-tint', alpha(AGENT_DARK, '.06'), alpha(AGENT_LIGHT, '.06')),
  swap('--agent-tint-strong', alpha(AGENT_DARK, '.10'), alpha(AGENT_LIGHT, '.10')),
  swap('--agent-edge', alpha(AGENT_DARK, '.40'), alpha(AGENT_LIGHT, '.40')),
  swap('--agent-edge-strong', alpha(AGENT_DARK, '.50'), alpha(AGENT_LIGHT, '.50')),
  // Secondary agent hues — for telling several agents apart at a glance. Hue rotates; L and C do not.
  swap('--agent-2', 'oklch(0.8 0.06 200)', 'oklch(0.5 0.11 200)'),
  swap('--agent-3', 'oklch(0.8 0.06 300)', 'oklch(0.5 0.13 300)'),
  // Attention = ONLY "needs you" / blocked / risky. Never decoration, never a second agent colour.
  swap('--attention', ATTENTION_DARK, ATTENTION_LIGHT),
  swap('--attention-text', 'oklch(0.84 0.08 60)', 'oklch(0.45 0.15 48)'),
  swap('--attention-tint', alpha(ATTENTION_DARK, '.06'), alpha(ATTENTION_LIGHT, '.06')),
  swap('--attention-tint-strong', alpha(ATTENTION_DARK, '.10'), alpha(ATTENTION_LIGHT, '.10')),
  swap('--attention-edge', alpha(ATTENTION_DARK, '.45'), alpha(ATTENTION_LIGHT, '.45')),
  swap('--attention-edge-strong', alpha(ATTENTION_DARK, '.50'), alpha(ATTENTION_LIGHT, '.50')),

  // ── The §11 inversions (§11 "Inversions to remember") ───────────────────────────────────────
  // The action-primary pill, reserved for control transfer and consent.
  swap('--action-primary-bg', '#fff', '#141414'),
  swap('--action-primary-text', '#000', '#fff'),
  // A mark sits on the ground it annotates: black plate in dark, white plate in light.
  swap('--mark-bg', '#000', '#fff'),
  // Ink on an accent fill — the ghost-cursor label chip, and anything else filled with an accent.
  swap('--on-accent-text', '#000', '#fff'),

  // ── Terminal (§4 `terminal`, §11 "Terminals invert back") ───────────────────────────────────
  swap('--term-text', 'rgba(255,255,255,.78)', 'rgba(255,255,255,.82)'),
  swap('--term-dim', 'rgba(255,255,255,.34)', 'rgba(255,255,255,.42)'),
  swap('--term-agent', 'oklch(0.88 0.04 250)', 'oklch(0.84 0.08 250)'),
  swap('--term-attention', 'oklch(0.84 0.08 60)', 'oklch(0.84 0.09 60)'),

  // ── Type families (§3 Type) ─────────────────────────────────────────────────────────────────
  fixed('--sans', "'Helvetica Neue', Helvetica, Arial, sans-serif"),
  fixed('--mono', 'ui-monospace, Menlo, monospace'),
  // Serif is ONLY for rendered web content.
  fixed('--serif', "Georgia, 'Times New Roman', serif"),

  // ── Type scale (§3 Type, scale table) ───────────────────────────────────────────────────────
  // `font` shorthand does not carry letter-spacing, so tracking is its own token per step.
  fixed('--type-display', '300 40px/1.18 var(--sans)'),
  fixed('--tracking-display', '-.015em'),
  fixed('--type-stat', '300 30px/1 var(--sans)'),
  fixed('--tracking-stat', '0'),
  fixed('--type-page-h1', '400 24px/1.25 var(--serif)'),
  fixed('--tracking-page-h1', '-.01em'),
  fixed('--type-card-title', '400 13px/1 var(--sans)'),
  fixed('--tracking-card-title', '.08em'),
  fixed('--type-body', '400 12.5px/1.45 var(--sans)'),
  fixed('--tracking-body', '0'),
  fixed('--type-body-sm', '400 12px/1.4 var(--sans)'),
  fixed('--tracking-body-sm', '0'),
  fixed('--type-pill', '400 11px/1 var(--sans)'),
  fixed('--tracking-pill', '0'),
  fixed('--type-pill-mono', '400 10.5px/1 var(--mono)'),
  fixed('--tracking-pill-mono', '0'),
  fixed('--type-mono-body', '400 10.5px/1.5 var(--mono)'),
  fixed('--type-mono-body-loose', '400 10.5px/1.7 var(--mono)'),
  fixed('--tracking-mono-body', '0'),
  fixed('--type-micro-caps', '500 9px/1 var(--sans)'),
  fixed('--tracking-micro-caps', '.2em'),
  fixed('--type-chrome-caps', '400 11px/1 var(--sans)'),
  fixed('--tracking-chrome-caps', '.14em'),
  fixed('--type-wordmark', '300 22px/1 var(--sans)'),
  fixed('--tracking-wordmark', '.34em'),

  // ── Radii (§3 Radii) ────────────────────────────────────────────────────────────────────────
  fixed('--radius-window', '18px'),
  fixed('--radius-large', '14px'),
  fixed('--radius-card', '12px'),
  fixed('--radius-inner', '10px'),
  fixed('--radius-inner-lg', '11px'),
  fixed('--radius-control', '8px'),
  fixed('--radius-segment', '6px'),
  fixed('--radius-pill', '999px'),

  // ── Spacing (§3 Spacing) ────────────────────────────────────────────────────────────────────
  // Rhythm rule: cards are 14 padding / 10 gap; grids are 16 gap. Do not improvise.
  fixed('--space-gutter', '40px'),
  fixed('--space-section', '88px'),
  fixed('--space-grid', '16px'),
  fixed('--space-card', '14px'),
  fixed('--space-card-dashed', '13px'),
  fixed('--space-stack', '10px'),
  fixed('--space-stack-tight', '9px'),
  fixed('--space-chip', '7px'),
  fixed('--space-chip-dense', '5px'),

  // ── Elevation (§3 Elevation, §11 Elevation & texture) ───────────────────────────────────────
  // No other shadows. No glows.
  swap('--shadow-window', '0 24px 80px rgba(0,0,0,.9)', '0 18px 46px rgba(0,0,0,.10)'),
  swap('--shadow-popover', '0 22px 50px rgba(0,0,0,.85)', '0 16px 38px rgba(0,0,0,.14)'),
  swap('--shadow-popover-page', '0 18px 44px rgba(0,0,0,.22)', '0 14px 34px rgba(0,0,0,.16)'),

  // ── Textures (§3 Textures, §11 Elevation & texture) ─────────────────────────────────────────
  // Marks mocked live web content inside a frame. Never decoration.
  swap(
    '--page-hatch',
    'repeating-linear-gradient(135deg, rgba(255,255,255,.035) 0 9px, rgba(255,255,255,0) 9px 18px)',
    'repeating-linear-gradient(135deg, rgba(0,0,0,.045) 0 9px, rgba(0,0,0,0) 9px 18px)',
  ),
  // At most once per screen.
  swap(
    '--hero-wash',
    'radial-gradient(120% 90% at 50% -10%, rgba(255,255,255,.09) 0%, rgba(255,255,255,0) 58%)',
    'radial-gradient(120% 90% at 50% -10%, rgba(0,0,0,.055) 0%, rgba(0,0,0,0) 58%)',
  ),
];

/**
 * The names the pre-restyle renderer used, kept only so they can be asserted GONE.
 *
 * These were the alias bridge that carried the shipped components onto the layer without rewriting
 * them: `--human`, `--working`, `--blocked`, `--ok` and `--danger` were five colours standing for four
 * states, where §3 allows exactly two accent families. The restyle rebuilt every component against
 * the §4 inventory, so the bridge is deleted and each name now resolves to nothing — which is the
 * failure mode this list exists to catch. A CSS custom property fails soft: a component that still
 * referenced `--text-dim` would silently lose its colour, with a green typecheck and a passing suite,
 * so the only thing that can catch it is a grep the test suite runs. That is `tokens.test.ts`.
 *
 * Nothing may be added here. A name in this list is a name no stylesheet may reference again.
 */
export const RETIRED_PROPERTIES: readonly string[] = [
  '--surface', '--surface-2', '--surface-3', '--surface-hover',
  '--border', '--border-soft',
  '--text', '--text-dim', '--text-faint',
  '--agent-dim',
  '--human', '--working', '--blocked', '--ok', '--danger',
  '--chrome-font',
  '--r-pill', '--r-lg', '--r-md', '--r-sm',
];

/** The attribute on `<html>` that selects the active register. */
export const REGISTER_ATTR = 'data-register';

/**
 * The register the layer falls back to when nothing has selected one.
 *
 * `:root` carries this register's values as well as its own `[data-register]` block, so a document
 * that somehow reaches paint before the attribute is written renders dark rather than unstyled — a
 * missing attribute must not be able to produce a colourless app.
 */
export const DEFAULT_REGISTER: Register = 'dark';

/** Resolve one token in one register. Used by the main process, which has no DOM to resolve against. */
export function tokenValue(name: string, register: Register): string {
  const token = TOKENS.find((t) => t.name === name);
  if (!token) throw new Error(`unknown design token: ${name}`);
  return token[register];
}

/** The custom-property declarations for one register, one per line. */
export function registerDeclarations(register: Register): string {
  return TOKENS.map((t) => `  ${t.name}: ${t[register]};`).join('\n');
}

/**
 * The whole layer as one stylesheet.
 *
 * Both registers are emitted from the same array, which is what makes the switch a single attribute
 * write rather than a swap of two files.
 */
export function tokenCss(): string {
  // `:root` holds the default register; the attributed blocks are more specific and win once a
  // register is selected, so a document that reaches paint before the attribute is written renders
  // dark rather than unstyled.
  const base = `:root {\n${registerDeclarations(DEFAULT_REGISTER)}\n}`;
  const registers = REGISTERS.map(
    (r) => `:root[${REGISTER_ATTR}="${r}"] {\n${registerDeclarations(r)}\n}`,
  ).join('\n\n');
  return `${base}\n\n${registers}\n`;
}

/**
 * The layer for a surface that has no `<html>` of ours to carry the register attribute.
 *
 * The per-tab overlay draws inside a closed shadow root on a page we do not own, so it cannot inherit
 * the chrome's `[data-register]` — and it must not, because a mark drawn over live web content has to
 * be legible whichever ground it lands on. `prefers-color-scheme` is the register both sides already
 * resolve against (the chrome follows it, and the main process resolves the window ground from the
 * same OS signal), so a media query keeps the overlay in step with the chrome without any plumbing
 * between them: no IPC, no listener, and nothing to go stale while a run is driving a tab.
 *
 * Both registers still come from the one `TOKENS` array — this is a second selector, not a second
 * definition.
 *
 * `selector` is REQUIRED and must name an element INSIDE the shadow tree — never `:host`. Custom
 * properties are inherited, and inheritance crosses the shadow boundary that `mode: 'closed'` and
 * `all: initial` both leave open: a normal declaration on the host element written by the OUTER tree
 * beats a `:host` rule written by the inner one, so a page that can select the host can blank every
 * token the surface draws with. On a page we do not own that is a hostile page hiding the browser's
 * own supervision UI. Page CSS cannot match anything inside a shadow tree, so one selector deeper is
 * out of reach — declaring on `.layer` and letting the drawn elements inherit from it costs one
 * wrapper and closes the hole. There is no default for that reason.
 */
export function shadowTokenCss(selector: string): string {
  const dark = `${selector} {\n${registerDeclarations('dark')}\n}`;
  const light = `@media (prefers-color-scheme: light) {\n${selector} {\n${registerDeclarations('light')}\n}\n}`;
  return `${dark}\n\n${light}\n`;
}
