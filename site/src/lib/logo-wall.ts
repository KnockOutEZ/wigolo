/**
 * Logo wall data: the curated company list resolved into render-ready rows.
 *
 * Runs at build time only (the page is statically exported): simple-icons path
 * data lands in the /logo-wall.svg sprite, rasters are pre-processed files in
 * /logos/, and no logo is ever fetched from a third party at runtime.
 * Framework-free with relative imports so the root vitest suite can load it.
 */
import * as simpleIcons from "simple-icons";
import { svgPathBbox } from "svg-path-bbox";
import companiesJson from "../content/logo-wall/companies.json";
import rastersJson from "../content/logo-wall/rasters.json";

export type Display = "icon+name" | "wordmark" | "name";

export interface Company {
  name: string;
  slug: string;
  tier: 1 | 2;
  evidence: "verified" | "self-reported";
  display: Display;
  logo:
    | { source: "simple-icons"; id: string }
    | { source: "github-avatar"; org: string }
    | { source: "favicon"; domain: string }
    | { source: "file" }
    | { source: "none" };
}

export type Mark =
  | {
      kind: "svg";
      symbolId: string;
      /** The symbol's own viewBox — crops wordmarks to their path bounds. */
      viewBox: string;
      /** Viewport for the referencing <svg>: `<use>` places the symbol at 0,0. */
      frame: string;
      path: string;
      aspect: number;
    }
  | { kind: "mask"; src: string; aspect: number }
  | { kind: "none" };

export interface WallItem {
  name: string;
  slug: string;
  display: Display;
  mark: Mark;
}

type Rasters = Record<string, { w: number; h: number }>;

const iconsBySlug = new Map(
  Object.values(simpleIcons as Record<string, unknown>)
    .filter((v): v is { slug: string; path: string } =>
      typeof v === "object" && v !== null && "slug" in v && "path" in v,
    )
    .map((i) => [i.slug, i]),
);

/** Pad a tight bbox by a hair so anti-aliased edges don't clip. */
const PAD = 0.2;

function svgMark(c: Company, id: string): Mark {
  const icon = iconsBySlug.get(id);
  if (!icon) throw new Error(`logo wall: no simple-icons icon "${id}" for ${c.name}`);
  // Icons fill a 24×24 box; a wordmark only fills a thin band of it, so crop
  // to the path's bounds or it renders a fraction of the intended size.
  if (c.display === "wordmark") {
    const [x0, y0, x1, y1] = svgPathBbox(icon.path);
    const w = x1 - x0 + PAD * 2;
    const h = y1 - y0 + PAD * 2;
    return {
      kind: "svg",
      symbolId: `lw-${c.slug}`,
      viewBox: `${(x0 - PAD).toFixed(3)} ${(y0 - PAD).toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)}`,
      frame: `0 0 ${w.toFixed(3)} ${h.toFixed(3)}`,
      path: icon.path,
      aspect: w / h,
    };
  }
  return {
    kind: "svg",
    symbolId: `lw-${c.slug}`,
    viewBox: "0 0 24 24",
    frame: "0 0 24 24",
    path: icon.path,
    aspect: 1,
  };
}

export function resolveMark(c: Company, rasters: Rasters): Mark {
  switch (c.logo.source) {
    case "none":
      return { kind: "none" };
    case "simple-icons":
      return svgMark(c, c.logo.id);
    default: {
      const size = rasters[c.slug];
      if (!size) throw new Error(`logo wall: no raster size for ${c.name}; run npm run logos:fetch`);
      return { kind: "mask", src: `/logos/${c.slug}.png`, aspect: size.w / size.h };
    }
  }
}

export interface Wall {
  top: WallItem[];
  bottom: WallItem[];
  /** Every distinct SVG mark, emitted once as a <symbol> sprite. */
  symbols: Extract<Mark, { kind: "svg" }>[];
}

export function buildWall(
  companies: readonly Company[] = companiesJson as Company[],
  rasters: Rasters = rastersJson as Rasters,
): Wall {
  const items = companies.map((c) => ({
    tier: c.tier,
    item: { name: c.name, slug: c.slug, display: c.display, mark: resolveMark(c, rasters) },
  }));
  const symbols = items
    .map(({ item }) => item.mark)
    .filter((m): m is Extract<Mark, { kind: "svg" }> => m.kind === "svg");
  return {
    top: items.filter((i) => i.tier === 1).map((i) => i.item),
    bottom: items.filter((i) => i.tier === 2).map((i) => i.item),
    symbols,
  };
}

const STAR_DATA =
  "https://raw.githubusercontent.com/KnockOutEZ/wigolo/star-chart/star-data.json";

/** Last published count, floored to 100 so the caption never overstates. */
export function captionCount(series: unknown, fallback: number): number {
  if (!Array.isArray(series) || series.length === 0) return fallback;
  const last = series[series.length - 1];
  const n = Array.isArray(last) ? Number(last[1]) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n / 100) * 100;
}

/**
 * Star count at build time from the daily star-chart branch. A network
 * failure must not fail the build, so it falls back to a known floor.
 */
export async function starCount(fallback = 5300): Promise<number> {
  try {
    const res = await fetch(STAR_DATA, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return fallback;
    return captionCount(await res.json(), fallback);
  } catch {
    return fallback;
  }
}
