import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_REGISTER,
  LEGACY_ALIASES,
  REGISTERS,
  TOKENS,
  registerDeclarations,
  tokenCss,
  tokenValue,
} from '../../src/renderer/tokens';

const REPO_ROOT = join(import.meta.dirname, '../../../..');
const DESIGN_SYSTEM = readFileSync(join(REPO_ROOT, 'DESIGN_SYSTEM.md'), 'utf8');
const STUDIO_CSS = readFileSync(
  join(import.meta.dirname, '../../src/renderer/studio.css'),
  'utf8',
);

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

describe('the legacy alias bridge', () => {
  it('resolves every alias to a token that exists', () => {
    // An alias pointing at a token that was renamed resolves to nothing and the component silently
    // loses its colour — a class of bug no typecheck can see, because CSS custom properties fail soft.
    for (const [alias, value] of Object.entries(LEGACY_ALIASES)) {
      const target = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
      expect(target, `${alias} must be a single var() reference, got ${value}`).not.toBeNull();
      expect(names.has(target![1]), `${alias} → ${target![1]} is not a token`).toBe(true);
    }
  });

  it('never aliases a name to a token that is itself an alias', () => {
    for (const value of Object.values(LEGACY_ALIASES)) {
      const target = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim())![1];
      expect(LEGACY_ALIASES[target]).toBeUndefined();
    }
  });

  it('keeps attention meaning only "needs you"', () => {
    // §3: attention is ONLY needs-you / blocked / risky. Provenance ("a human did this") and a
    // settled outcome want nobody, so routing them to amber would make the accent mean nothing —
    // which is exactly what the old five-colour palette did.
    const attention = ['--working', '--blocked', '--danger'];
    for (const name of attention) expect(LEGACY_ALIASES[name]).toBe('var(--attention)');
    for (const name of ['--human', '--ok']) {
      expect(LEGACY_ALIASES[name]).not.toContain('attention');
    }
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
    const surface = `${tokenCss()}\n${STUDIO_CSS}`;
    expect(retired.filter((value) => surface.includes(value))).toEqual([]);
  });

  it('leaves no colour declared outside the token layer', () => {
    // The teeth of "never invent a token": the chrome stylesheet may reference colours but must not
    // define them, because a literal in here exists in one register only by construction.
    const literals = STUDIO_CSS.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/g);
    expect(literals ?? []).toEqual([]);
  });

  it('declares no shadow or glow the design system does not list', () => {
    // §3 allows three shadows and says "no glows". The dot glows this file used to carry were an
    // invented blur radius doing the work a hue was already doing.
    const shadows = [...STUDIO_CSS.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const shadow of shadows) {
      expect(shadow).toMatch(/^var\(--(shadow-|shadow-rail)/);
    }
  });
});
