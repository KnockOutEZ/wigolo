import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
 * per-tab overlay that draws over live web content, and the components themselves — a component that
 * reintroduced an inline colour would be invisible to a stylesheet-only assertion.
 */
const STYLING_SOURCES: readonly { readonly path: string; readonly text: string }[] = [
  { path: 'renderer/studio.css', text: STUDIO_CSS },
  { path: 'preload/overlay.ts', text: OVERLAY },
  ...['App', 'ApprovalCard', 'BriefPanel', 'CapturesPanel', 'ChatPanel', 'DriveBanner', 'GrantCard',
    'KnowledgeRail', 'LoginCard', 'MarksPanel', 'Omnibox', 'TabStrip', 'TimelinePanel', 'icons']
    .map((name) => ({ path: `renderer/${name}.tsx`, text: read(`renderer/${name}.tsx`) })),
];

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
      const literals = text.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/g);
      for (const literal of literals ?? []) offenders.push(`${path} → ${literal}`);
    }
    expect(offenders).toEqual([]);
  });

  it('would flag a colour literal in a component if one were added back', () => {
    // Control for the sweep above: the pattern has to catch an inline style, not just a stylesheet
    // declaration, because a component is where the next one would land.
    const inline = `<span style={{ background: 'rgba(255,255,255,.05)' }} />`;
    expect(inline.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/g)).toEqual(['rgba(']);
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
    // §9: "Inventing a font size or spacing value not in §3." Sizes and radii are token sets, so a
    // literal `font-size: 14.5px` or `border-radius: 9px` is a value that exists in neither register's
    // definition — it is the old aesthetic's editorial serif and soft corners coming back by hand.
    const offenders: string[] = [];
    for (const { path, text } of STYLING_SOURCES) {
      for (const m of text.matchAll(/(?:^|[;{\s])(font-size|font|border-radius)\s*:\s*([^;}]+)/g)) {
        const [, property, value] = m;
        if (property === 'font' && /^\s*(family|inherit)/.test(value)) continue;
        if (/^\s*(inherit|unset|initial|var\(--(type|radius|tracking)-)/.test(value)) continue;
        // A radius that mirrors the target element's own corner is data, not a design value.
        if (/^\s*''\s*$/.test(value) || /cs\.borderRadius/.test(value)) continue;
        offenders.push(`${path} → ${property}: ${value.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps serif out of the chrome and emoji out of every surface', () => {
    // §3: serif is ONLY for rendered web content, and the chrome is not that — the editorial-serif
    // assistant voice was the single loudest piece of the retired look. §9 forbids emoji outright.
    expect(STUDIO_CSS).not.toMatch(/var\(--serif\)/);
    const emoji = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const { path, text } of STYLING_SOURCES) {
      expect(emoji.test(text), `${path} carries an emoji`).toBe(false);
    }
    // Control: the glyphs that were there are exactly what this pattern catches.
    expect(emoji.test('🔑')).toBe(true);
    expect(emoji.test('➤')).toBe(true);
    // …and the studio's dingbat vocabulary is NOT emoji, so the rule does not ban the mark glyph.
    expect(emoji.test('◈ 12')).toBe(false);
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
