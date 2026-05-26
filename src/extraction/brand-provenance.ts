/**
 * Brand extractor provenance enums — single source of truth.
 *
 * Why this file exists (slice 4 / flaw L3):
 *   The audit (cc-test-report.md row L3) caught us emitting provenance
 *   values that weren't in the documented enum (e.g. 'palette-extraction'
 *   showed up in real output but wasn't documented). The TS type
 *   `BrandExtractionOutput['provenance']` carries one form of the
 *   declaration, but the code, tests, and external docs each duplicate it.
 *   Drift is inevitable.
 *
 * Fix: every emission point reads from these arrays. The type in
 * `src/types.ts` is derived from them. The brand-honesty test asserts the
 * exact contents. Add a value HERE first; the type + emission sites
 * follow automatically.
 *
 * Order matters: these enums also serve as documentation order in the
 * TypeScript type, the tool-schemas surface, and the docs file.
 */

export const LOGO_PROVENANCE_VALUES = [
  'json-ld',
  'og:logo',
  'link[rel=icon]',
  'heuristic',
  'unknown',
] as const;
export type LogoProvenance = (typeof LOGO_PROVENANCE_VALUES)[number];

export const COLORS_PROVENANCE_VALUES = [
  'css-vars',
  'palette-extraction',
  'unknown',
] as const;
export type ColorsProvenance = (typeof COLORS_PROVENANCE_VALUES)[number];

export const FONTS_PROVENANCE_VALUES = [
  'css-vars',
  'css-rule',
  'inline-style',
  'google-fonts-link',
  'unknown',
] as const;
export type FontsProvenance = (typeof FONTS_PROVENANCE_VALUES)[number];
