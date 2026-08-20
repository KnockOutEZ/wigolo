import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_REGISTER,
  REGISTERS,
  RETIRED_PROPERTIES,
  TOKENS,
  registerDeclarations,
  shadowTokenCss,
  tokenCss,
  tokenValue,
} from '../../src/renderer/tokens';

const REPO_ROOT = join(import.meta.dirname, '../../../..');
const DESIGN_SYSTEM = readFileSync(join(REPO_ROOT, 'DESIGN_SYSTEM.md'), 'utf8');
const SRC = join(import.meta.dirname, '../../src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const STUDIO_CSS = read('renderer/studio.css');
const OVERLAY = read('preload/overlay.ts');

/**
 * Every file that styles something, which is what the restyle had to cover: the chrome stylesheet, the
 * per-tab overlay that draws over live web content, the components themselves — a component that
 * reintroduced an inline colour would be invisible to a stylesheet-only assertion — and the two
 * processes outside the renderer that also resolve a token (the preloads and the main process, which
 * paints the window's own ground).
 *
 * ENUMERATED FROM DISK, not listed. The hand-maintained list this replaced named 14 components while
 * `src/renderer` held 15 files ending `.tsx`, and named nothing at all in `src/preload` or `src/main`:
 * a new `SettingsPanel.tsx` carrying `rgba(255,255,255,.05)` was swept by no assertion in this file
 * and passed every one of them. A list cannot fail when a file is added to the tree; a `readdirSync`
 * can. The floors asserted below are what stop the opposite failure — a glob that resolves to nothing
 * satisfies every sweep here vacuously.
 */
const SWEPT_DIRECTORIES: readonly { readonly dir: string; readonly exts: readonly string[] }[] = [
  { dir: 'renderer', exts: ['.tsx', '.ts', '.css', '.html'] },
  { dir: 'preload', exts: ['.ts'] },
  { dir: 'main', exts: ['.ts'] },
];

/**
 * The one file that MUST define colour — it IS the token layer. Sweeping it would ban the tokens.
 * Its own values are held to §3/§11 by the coverage tests at the top of this file instead.
 */
const TOKEN_LAYER = 'renderer/tokens.ts';

const STYLING_SOURCES: readonly { readonly path: string; readonly text: string }[] =
  SWEPT_DIRECTORIES.flatMap(({ dir, exts }) =>
    readdirSync(join(SRC, dir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && exts.some((ext) => entry.name.endsWith(ext)))
      .map((entry) => `${dir}/${entry.name}`)
      .filter((path) => path !== TOKEN_LAYER)
      .sort()
      .map((path) => ({ path, text: read(path) })),
  );

/**
 * The paint sweep, as a function so the real sources and the in-test controls run the SAME pattern —
 * a control that exercises a copy of the pattern proves the copy works.
 *
 * Two halves, because a colour is spelled two ways. `#0c0c10`, `rgba(…)`, `oklch(…)` are one class and
 * were the whole of this sweep; `color: red` and `background: white` are the other, and passed it. A
 * named colour is a literal in exactly the sense that matters here — it has one appearance, so it is
 * right in at most one register.
 */
const COLOUR_FUNCTION = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/g;

/**
 * Not all 148 CSS names — the ones a person types by hand when reaching for "just make it red". The
 * keyword-valued non-colours (`transparent`, `currentColor`, `inherit`) are deliberately absent: they
 * carry no appearance of their own, which is why the overlay is allowed to use `currentColor`.
 */
const NAMED_COLOUR = new RegExp(
  '\\b(?:red|green|blue|white|black|gray|grey|yellow|orange|purple|violet|indigo|pink|brown|cyan|' +
  'magenta|lime|navy|teal|olive|maroon|silver|gold|crimson|salmon|coral|khaki|plum|orchid|tan|aqua|' +
  'fuchsia|beige|ivory|turquoise|lavender|tomato|wheat|azure|snow|seagreen|skyblue|steelblue|' +
  'slategray|slategrey|darkred|darkgreen|darkblue|lightgray|lightgrey|whitesmoke|gainsboro|dimgray|' +
  'dimgrey|hotpink|rebeccapurple)\\b',
);

/** A property whose value is a paint — hyphenated for CSS, camelCase for a TSX inline style. */
const PAINT_PROPERTY =
  '(?:[a-zA-Z]*-color|[a-zA-Z]*Color|color|background|background-[a-z]+|border|border-[a-z-]+|' +
  'border[A-Z][a-zA-Z]*|outline|outline-[a-z]+|fill|stroke|box-shadow|boxShadow|text-shadow|' +
  'textShadow|caret-color)';

const PAINT_DECLARATION = new RegExp(`(?:^|[;{,(\\s])${PAINT_PROPERTY}\\s*:\\s*([^;}\\n]*)`, 'g');

/** Every colour literal in one source, however spelled. */
function colourLiterals(text: string): string[] {
  const found = [...(text.match(COLOUR_FUNCTION) ?? [])];
  for (const [, value] of text.matchAll(PAINT_DECLARATION)) {
    const named = NAMED_COLOUR.exec(value);
    if (named) found.push(named[0]);
  }
  return found;
}

/**
 * The size sweep. §9: "Inventing a font size or spacing value not in §3." Sizes and radii are token
 * sets, so a literal `font-size: 14.5px` or `border-radius: 9px` is a value defined in neither
 * register. The camelCase spellings are here because a TSX inline style is where the next one lands:
 * `style={{ borderRadius: '9px', fontSize: 15 }}` is not CSS text and was matched by nothing.
 */
const SIZE_DECLARATION =
  /(?:^|[;{,(\s])(font-size|fontSize|font-family|fontFamily|font|border-radius|borderRadius)\s*:\s*([^;}\n]*)/g;

function sizeLiterals(text: string): string[] {
  const offenders: string[] = [];
  for (const [, property, raw] of text.matchAll(SIZE_DECLARATION)) {
    const value = raw.trim().replace(/,\s*$/, '');
    // `font-family`/`fontFamily` name a family, which is a token reference or nothing at all.
    if (/^font(-family|Family)$/.test(property) || (property === 'font' && /^\s*(family|inherit)/.test(value))) continue;
    if (/^['"`]?\s*(inherit|unset|initial|var\(--(type|radius|tracking)-)/.test(value)) continue;
    // A radius that mirrors the target element's own corner is data read off the page, not a design
    // value: the overlay outlines whatever it is drawn around.
    if (/^['"`]{2}$/.test(value) || /cs\.borderRadius/.test(value)) continue;
    offenders.push(`${property}: ${value}`);
  }
  return offenders;
}

/** §9 forbids emoji outright. The studio's dingbat vocabulary (`◈`) is not in these blocks. */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}]/u;

const names = new Set(TOKENS.map((t) => t.name));
const declaredNames = (register: 'dark' | 'light'): string[] =>
  registerDeclarations(register)
    .split('\n')
    .map((line) => line.trim().split(':')[0]);

describe('the token layer covers the design system', () => {
  /**
   * The outside signal. `DESIGN_SYSTEM.md` is the authority and is tracked at the repo root, so a
   * token added THERE and not here fails this test rather than being discovered when a screen is
   * built against a property that resolves to nothing.
   */
  it('defines every `--`-named token the design system writes out', () => {
    const fromDoc = new Set(
      // `--[a-z]` and not `--[a-z0-9-]`: a markdown `---` rule otherwise reads as a token name.
      [...DESIGN_SYSTEM.matchAll(/^\s*(--[a-z][a-z0-9-]*)\s{2,}/gim)].map((m) => m[1]),
    );
    // Sanity: if the extraction stops matching, the assertion below becomes vacuously true.
    expect(fromDoc.size).toBeGreaterThan(15);
    expect([...fromDoc].filter((n) => !names.has(n))).toEqual([]);
  });

  it('names the tokens the design system describes by role rather than by property', () => {
    // §3/§11 give these as a table of roles, not as custom properties, so the coverage claim above
    // cannot see them — they are pinned here explicitly.
    const byRole = [
      // text alphas
      '--text-primary', '--text-emphasis', '--text-body', '--text-secondary', '--text-label',
      '--text-mono-muted', '--text-mono', '--text-micro', '--text-hint', '--text-placeholder',
      // type families + scale
      '--sans', '--mono', '--serif',
      '--type-display', '--type-stat', '--type-page-h1', '--type-card-title', '--type-body',
      '--type-body-sm', '--type-pill', '--type-pill-mono', '--type-mono-body', '--type-micro-caps',
      '--type-chrome-caps', '--type-wordmark',
      '--tracking-display', '--tracking-page-h1', '--tracking-card-title', '--tracking-micro-caps',
      '--tracking-chrome-caps', '--tracking-wordmark',
      // radii
      '--radius-window', '--radius-large', '--radius-card', '--radius-inner', '--radius-control',
      '--radius-segment', '--radius-pill',
      // spacing
      '--space-gutter', '--space-section', '--space-grid', '--space-card', '--space-card-dashed',
      '--space-stack', '--space-stack-tight', '--space-chip', '--space-chip-dense',
      // elevation + textures
      '--shadow-window', '--shadow-popover', '--shadow-popover-page', '--page-hatch', '--hero-wash',
      // the §11 inversions and the terminal, which keeps one appearance in both registers
      '--action-primary-bg', '--action-primary-text', '--mark-bg', '--on-accent-text',
      '--term-text', '--term-dim', '--term-agent', '--term-attention',
    ];
    expect(byRole.filter((n) => !names.has(n))).toEqual([]);
  });

  it('carries the light register for tokens the design system only lists under §11', () => {
    // A light-only surface with no dark counterpart would leave the dark register resolving nothing.
    for (const name of ['--surface-window', '--surface-mock']) {
      expect(tokenValue(name, 'dark')).not.toBe('');
      expect(tokenValue(name, 'light')).not.toBe('');
    }
  });

  it('refuses an unknown token instead of returning an empty value', () => {
    // The main process resolves `--bg` through this. A silent '' there paints a black window in the
    // light register and looks like a compositing bug, not a typo.
    expect(() => tokenValue('--not-a-token', 'dark')).toThrow(/unknown design token/);
  });
});

describe('both registers come from one definition', () => {
  it('emits the same token names, in the same order, for every register', () => {
    // This is the "adding a token means editing exactly one place" property: the registers are two
    // projections of one array, so they cannot drift. A serializer that skipped or reordered tokens
    // for one register — the shape two hand-written `:root` blocks always eventually reach — fails here.
    const dark = declaredNames('dark');
    expect(dark).toHaveLength(TOKENS.length);
    for (const register of REGISTERS) {
      expect(declaredNames(register)).toEqual(dark);
    }
  });

  it('gives every token a value in every register', () => {
    for (const token of TOKENS) {
      for (const register of REGISTERS) {
        expect(token[register], `${token.name} in ${register}`).toMatch(/\S/);
      }
    }
  });

  it('re-anchors the ground and the accents between registers rather than reusing them', () => {
    // §11 is "same system, re-anchored": if these came out equal the light register would be the dark
    // one with a different name, which is the failure this whole issue exists to prevent.
    for (const name of ['--bg', '--surface-panel', '--agent', '--attention', '--hair', '--text-primary']) {
      expect(tokenValue(name, 'dark')).not.toBe(tokenValue(name, 'light'));
    }
    // …and the terminal deliberately does NOT re-anchor to a light ground (§11).
    expect(tokenValue('--surface-term', 'light')).toBe('#16171b');
  });

  it('emits one block per register plus a default block, so a missing attribute still resolves', () => {
    const css = tokenCss();
    for (const register of REGISTERS) {
      expect(css).toContain(`:root[data-register="${register}"] {`);
    }
    const base = css.slice(0, css.indexOf('[data-register'));
    expect(base).toContain(':root {');
    expect(base).toContain(`--bg: ${tokenValue('--bg', DEFAULT_REGISTER)};`);
  });
});

describe('the retired alias bridge is gone, not merely unused', () => {
  it('declares none of the retired names anywhere in the emitted layer', () => {
    // The bridge is deleted, so these resolve to nothing. Emitting one again would let a component
    // reference it and quietly work, which is how the five-colour palette would grow back.
    const css = `${tokenCss()}\n${shadowTokenCss()}`;
    const declared = RETIRED_PROPERTIES.filter((name) =>
      new RegExp(`^\\s*${name}\\s*:`, 'm').test(css),
    );
    expect(declared).toEqual([]);
  });

  it('is referenced by nothing that styles anything', () => {
    // The teeth of the restyle. A CSS custom property fails SOFT: `var(--text-dim)` with no
    // `--text-dim` declared paints nothing and the element inherits, so a survivor is invisible to
    // the typecheck, to the suite, and to a screenshot of the one register it happens to look right
    // in. Only a grep catches it — so the grep lives here and runs on every commit.
    //
    // `\b` on the closing side matters: `--text` must not match `--text-primary`, and `--border`
    // must not match `--border-soft`. The control below proves the pattern can still find a hit.
    const survivors: string[] = [];
    for (const { path, text } of STYLING_SOURCES) {
      for (const name of RETIRED_PROPERTIES) {
        if (new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(text)) survivors.push(`${path} → ${name}`);
      }
    }
    expect(survivors).toEqual([]);
  });

  it('would find a retired name if one came back', () => {
    // The control run for the assertion above. A grep that finds nothing is only evidence once you
    // have shown it CAN find something — otherwise a typo in the pattern reads as a clean sweep.
    const reintroduced = '.tab { color: var(--text-dim); background: var(--surface-2); }';
    const found = RETIRED_PROPERTIES.filter((name) =>
      new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(reintroduced),
    );
    expect([...found].sort()).toEqual(['--surface-2', '--text-dim']);
    // …and the boundary it must NOT trip on: the live tokens whose names contain a retired one.
    const live = '.tab { color: var(--text-primary); border-color: var(--border-radius-not-a-token); }';
    expect(RETIRED_PROPERTIES.filter((n) => new RegExp(`var\\(\\s*${n}\\s*[,)]`).test(live))).toEqual([]);
  });

  it('keeps attention meaning only "needs you" now that the states resolve directly', () => {
    // §3: attention is ONLY needs-you / blocked / risky. Provenance ("a human drove this tab") and a
    // settled outcome ("ok") want nobody, so painting them amber would make the accent mean nothing —
    // which is exactly what the old five-colour palette did. These four rules are where that lives
    // after the restyle, so they are asserted by rule rather than through a bridge.
    const rule = (selector: string): string => {
      const found = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(STUDIO_CSS);
      expect(found, `${selector} must exist in the chrome stylesheet`).not.toBeNull();
      return found![1];
    };
    expect(rule('.tab__dot--human')).toContain('var(--text-label)');
    expect(rule('.tl__outcome.is-ok')).toContain('var(--text-label)');
    expect(rule('.mark-conf--high')).toContain('var(--text-label)');
    for (const selector of ['.tab__dot--human', '.tl__outcome.is-ok', '.mark-conf--high']) {
      expect(rule(selector)).not.toContain('attention');
    }
    // …and the states that DO want a person keep it.
    expect(rule('.tab__dot--working')).toContain('var(--attention)');
    expect(rule('.tl__outcome.is-refused')).toContain('var(--attention-text)');
  });
});

describe('the sweeps see every file that could style something', () => {
  const paths = STYLING_SOURCES.map((s) => s.path);

  it('still covers everything the hand-maintained list named', () => {
    // The enumeration replaced a literal list. If a glob narrows — a typo in an extension, a directory
    // renamed — these go red rather than the sweeps quietly covering less than they used to.
    for (const name of ['App', 'ApprovalCard', 'BriefPanel', 'CapturesPanel', 'ChatPanel', 'DriveBanner',
      'GrantCard', 'KnowledgeRail', 'LoginCard', 'MarksPanel', 'Omnibox', 'TabStrip', 'TimelinePanel',
      'icons']) {
      expect(paths).toContain(`renderer/${name}.tsx`);
    }
    expect(paths).toContain('renderer/studio.css');
    expect(paths).toContain('preload/overlay.ts');
  });

  it('covers the files the list did not name, each of which can carry a colour', () => {
    // Named individually because each one is a demonstrated hole, not a hypothetical: `main.tsx` is a
    // 15th `.tsx` the list of 14 never had; `index.html` is markup with a `style` attribute available
    // to it; the stores and the preloads and the main process all import the token layer, and the main
    // process resolves `--bg` for the window frame itself.
    for (const path of ['renderer/main.tsx', 'renderer/index.html', 'renderer/control-store.ts',
      'renderer/theme.ts', 'preload/index.ts', 'preload/overlay-core.ts', 'main/index.ts']) {
      expect(paths).toContain(path);
    }
  });

  it('excludes only the token layer, which is the one file allowed to define a colour', () => {
    expect(paths).not.toContain(TOKEN_LAYER);
    expect(colourLiterals(read(TOKEN_LAYER)).length).toBeGreaterThan(0);
  });

  it('has a floor under it, because an empty enumeration passes every sweep vacuously', () => {
    // The failure mode a `readdirSync` introduces that a list did not have: a wrong directory throws,
    // but a wrong EXTENSION silently yields nothing and every assertion below becomes true of nothing.
    // Floors rather than equalities, so adding a component is not a failing test.
    expect(paths.filter((p) => p.startsWith('renderer/') && p.endsWith('.tsx'))).toHaveLength(
      readdirSync(join(SRC, 'renderer')).filter((f) => f.endsWith('.tsx')).length,
    );
    expect(paths.filter((p) => p.endsWith('.tsx')).length).toBeGreaterThanOrEqual(15);
    expect(paths.filter((p) => p.startsWith('preload/')).length).toBeGreaterThanOrEqual(3);
    expect(paths.filter((p) => p.startsWith('main/')).length).toBeGreaterThanOrEqual(15);
    expect(paths.length).toBeGreaterThanOrEqual(44);
  });

  it('would fail on a new component that reintroduces a literal, which is the whole point', () => {
    // The must-fire case for the enumeration itself, standing in for the synthetic 15th component: a
    // file the list would not have named, carrying both spellings the widened sweeps now catch.
    const newComponent = `export const SettingsPanel = () => (
      <div className="settings" style={{ borderRadius: '9px' }}>
        <span style={{ color: 'red' }}>on</span>
      </div>
    );`;
    expect(colourLiterals(newComponent)).toEqual(['red']);
    expect(sizeLiterals(newComponent)).toEqual([`borderRadius: '9px'`]);
  });
});

describe('rule zero — no invented values reachable', () => {
  it('has retired every value from the old violet / green / red palette', () => {
    // Named individually rather than by pattern: each of these was a real declaration in this app,
    // and a reviewer can check the list against the deleted `:root` block.
    const retired = [
      '#8b7cf6', '139, 124, 246', '139,124,246', '#a06bff', '#6f4ad1', // violet
      '#4ade80', '74, 222, 128', '#6ee7b7', '#08210f', // green
      '#f87171', '248, 113, 113', // red
      '#fbbf24', '251, 191, 36', '245, 179, 90', // the old ambers
      '#0c0c10', '#15151b', '#1c1c24', '#24242e', '#26262f', '#1e1e26', // old greys
      '#e8e8ef', '#9c9caa', '#63636f', '#12101f', // old inks
    ];
    // The overlay is in this surface deliberately: it was the last home of the violet palette, and
    // it draws over live web content where a wrong hue is most visible.
    const surface = `${tokenCss()}\n${STUDIO_CSS}\n${OVERLAY}`;
    expect(retired.filter((value) => surface.includes(value))).toEqual([]);
  });

  it('leaves no colour declared outside the token layer, in any styling source', () => {
    // The teeth of "never invent a token": a stylesheet or a component may REFERENCE a colour but must
    // not DEFINE one, because a literal exists in one register only by construction. The overlay's
    // `currentColor` is the exception that proves it — an icon that takes its container's token is one
    // component in two registers, which is the whole point.
    const offenders: string[] = [];
    for (const { path, text } of STYLING_SOURCES) {
      for (const literal of colourLiterals(text)) offenders.push(`${path} → ${literal}`);
    }
    expect(offenders).toEqual([]);
  });

  it('would flag a colour literal in a component if one were added back, hex or named', () => {
    // Control for the sweep above: the pattern has to catch an inline style, not just a stylesheet
    // declaration, because a component is where the next one would land — and it has to catch the
    // spelling that has no `#` and no `(` in it, which is the one this sweep used to wave through.
    expect(colourLiterals(`<span style={{ background: 'rgba(255,255,255,.05)' }} />`)).toEqual(['rgba(']);
    expect(colourLiterals('.tab { color: red; }')).toEqual(['red']);
    expect(colourLiterals('.tab { background: white; }')).toEqual(['white']);
    expect(colourLiterals(`<b style={{ borderColor: 'crimson' }} />`)).toEqual(['crimson']);
    expect(colourLiterals('.a { border: 1px solid black; }')).toEqual(['black']);
    // …and the boundaries it must NOT trip on, or the sweep becomes noise a contributor learns to
    // suppress: token references, the keyword non-colours, and a property whose NAME contains one.
    expect(colourLiterals('.a { color: var(--text-primary); background: transparent; }')).toEqual([]);
    expect(colourLiterals(`<b style={{ whiteSpace: 'nowrap', color: 'currentColor' }} />`)).toEqual([]);
    expect(colourLiterals('.a { border: var(--hair-width) solid var(--agent); }')).toEqual([]);
  });

  it('declares no shadow or glow the design system does not list', () => {
    // §3 allows three shadows and says "no glows". The dot glows this file used to carry, and the
    // overlay's violet bloom, were an invented blur radius doing the work a hue was already doing.
    const shadows = [...`${STUDIO_CSS}\n${OVERLAY}`.matchAll(/box-shadow:\s*([^;]+);/g)]
      .map((m) => m[1].trim());
    expect(shadows.length).toBeGreaterThan(0); // else the assertion below is vacuous
    for (const shadow of shadows) expect(shadow).toMatch(/^var\(--shadow-/);
    // `filter: drop-shadow(...)` is a glow by another spelling — it is how the ghost cursor had one.
    expect(`${STUDIO_CSS}\n${OVERLAY}`).not.toMatch(/drop-shadow\(/);
  });

  it('invents no font size and no radius outside the type scale and the radii', () => {
    const offenders: string[] = [];
    for (const { path, text } of STYLING_SOURCES) {
      for (const offender of sizeLiterals(text)) offenders.push(`${path} → ${offender}`);
    }
    expect(offenders).toEqual([]);
  });

  it('would flag an invented size or radius in either spelling', () => {
    // Control for the sweep above. The camelCase half is not decoration: it is the spelling every one
    // of the 15 components would use, and until it was added the sweep only understood the stylesheet.
    expect(sizeLiterals('.a { font-size: 14.5px; }')).toEqual(['font-size: 14.5px']);
    expect(sizeLiterals('.a { border-radius: 9px; }')).toEqual(['border-radius: 9px']);
    expect(sizeLiterals(`<b style={{ borderRadius: '9px' }} />`)).toEqual([`borderRadius: '9px'`]);
    expect(sizeLiterals('<b style={{ fontSize: 15 }} />')).toEqual(['fontSize: 15']);
    // …and what it must let through: the token references, the family names, and the overlay's
    // read-off-the-page radius.
    expect(sizeLiterals('.a { font: var(--type-body); border-radius: var(--radius-card); }')).toEqual([]);
    expect(sizeLiterals(`<b style={{ borderRadius: 'var(--radius-pill)' }} />`)).toEqual([]);
    expect(sizeLiterals('.a { font-family: var(--mono); }')).toEqual([]);
    expect(sizeLiterals(`o.style.borderRadius = cs.borderRadius !== '0px' ? cs.borderRadius : '';`)).toEqual([]);
  });

  it('keeps serif out of the chrome and emoji out of every surface', () => {
    // §3: serif is ONLY for rendered web content, and the chrome is not that — the editorial-serif
    // assistant voice was the single loudest piece of the retired look. §9 forbids emoji outright.
    expect(STUDIO_CSS).not.toMatch(/var\(--serif\)/);
    for (const { path, text } of STYLING_SOURCES) {
      expect(EMOJI.test(text), `${path} carries an emoji`).toBe(false);
    }
    // Control: the glyphs that were there are exactly what this pattern catches.
    expect(EMOJI.test('🔑')).toBe(true);
    expect(EMOJI.test('➤')).toBe(true);
    expect(EMOJI.test('✂')).toBe(true);
    // …and the studio's dingbat vocabulary is NOT emoji, so the rule does not ban the mark glyph.
    expect(EMOJI.test('◈ 12')).toBe(false);
  });
});

describe('the overlay is one component in two registers', () => {
  it('carries both registers, from the same array, on its shadow root', () => {
    // The overlay lands in a page that has no `[data-register]` of ours, so a register block keyed on
    // that attribute would never match and the overlay would be dark-only over a light page.
    const css = shadowTokenCss();
    expect(css).toContain(':host {');
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(css).toContain(`--agent: ${tokenValue('--agent', 'dark')};`);
    expect(css).toContain(`--agent: ${tokenValue('--agent', 'light')};`);
    // Same names in both, for the same reason `tokenCss` emits them from one array.
    const block = (source: string): string[] =>
      [...source.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]);
    const [darkBlock, lightBlock] = css.split('@media');
    expect(block(lightBlock)).toEqual(block(darkBlock));
  });

  it('installs the layer on the shadow root rather than resolving values into the rules', () => {
    // Inlining resolved values would fork the overlay per register — the failure the token layer
    // exists to prevent, and one a screenshot in a single register cannot show.
    expect(OVERLAY).toMatch(/\$\{shadowTokenCss\(\)\}/);
  });
});
