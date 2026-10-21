#!/usr/bin/env node
// Materialise every raster logo named in src/content/logo-wall/companies.json
// into public/logos/<slug>.png as a cropped black-on-transparent silhouette,
// so the site never calls a third party at runtime and every logo takes the
// same monochrome treatment. simple-icons entries need no file — they render
// as inline SVG. Glyph sizes land in src/content/logo-wall/rasters.json so
// the component can reserve exact space.
//
//   node scripts/logo-wall/fetch-logos.mjs           download missing, reprocess all
//   node scripts/logo-wall/fetch-logos.mjs --force   re-download all
//   node scripts/logo-wall/fetch-logos.mjs --check   verify only (exit 1 on a gap)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { toSilhouette, alphaBounds, crop } from "./silhouette.mjs";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANIES = join(SITE, "src", "content", "logo-wall", "companies.json");
const LOGOS = join(SITE, "public", "logos");
const RAW_LOGOS = join(SITE, ".logo-wall", "raw-logos");
const RASTERS = join(SITE, "src", "content", "logo-wall", "rasters.json");
const CHECK = process.argv.includes("--check");
const FORCE = process.argv.includes("--force");

const require = createRequire(import.meta.url);
const icons = require("simple-icons");
const iconSlugs = new Set(Object.values(icons).filter((i) => i?.slug).map((i) => i.slug));

const sourceUrl = (logo) => {
  if (logo.source === "github-avatar") return `https://github.com/${logo.org}.png?size=128`;
  if (logo.source === "favicon")
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(logo.domain)}&sz=128`;
  return null;
};

const companies = JSON.parse(readFileSync(COMPANIES, "utf8"));
const problems = [];
const slugs = new Set();
const rasters = {};
mkdirSync(LOGOS, { recursive: true });
mkdirSync(RAW_LOGOS, { recursive: true });

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function process_(slug, rawFile) {
  const buf = readFileSync(rawFile);
  if (!buf.subarray(0, 4).equals(PNG_SIGNATURE)) {
    return `${slug}: source is not a PNG — drop a PNG at .logo-wall/raw-logos/${slug}.png`;
  }
  const src = PNG.sync.read(buf);
  const sil = toSilhouette(src.data, src.width, src.height);
  const box = alphaBounds(sil, src.width, src.height);
  if (!box) return `${slug}: logo is blank after background removal`;
  const out = new PNG({ width: box.w, height: box.h });
  out.data = Buffer.from(crop(sil, src.width, box));
  writeFileSync(join(LOGOS, `${slug}.png`), PNG.sync.write(out));
  rasters[slug] = { w: box.w, h: box.h };
  return null;
}

for (const c of companies) {
  if (slugs.has(c.slug)) problems.push(`${c.name}: duplicate slug "${c.slug}"`);
  slugs.add(c.slug);
  if (c.tier !== 1 && c.tier !== 2) problems.push(`${c.name}: tier must be 1 or 2`);
  if (c.evidence !== "verified" && c.evidence !== "self-reported")
    problems.push(`${c.name}: evidence must be "verified" or "self-reported"`);

  if (!["icon+name", "wordmark", "name"].includes(c.display))
    problems.push(`${c.name}: display must be "icon+name", "wordmark" or "name"`);
  if ((c.logo.source === "none") !== (c.display === "name"))
    problems.push(`${c.name}: display "name" and logo source "none" go together`);
  if (c.logo.source === "none") continue;

  if (c.logo.source === "simple-icons") {
    if (!iconSlugs.has(c.logo.id)) problems.push(`${c.name}: no simple-icons icon "${c.logo.id}"`);
    continue;
  }

  const file = join(LOGOS, `${c.slug}.png`);
  if (CHECK) {
    if (!existsSync(file)) problems.push(`${c.name}: missing public/logos/${c.slug}.png`);
    continue;
  }

  const rawFile = join(RAW_LOGOS, `${c.slug}.png`);
  if (c.logo.source !== "file" && (!existsSync(rawFile) || FORCE)) {
    const url = sourceUrl(c.logo);
    if (!url) {
      problems.push(`${c.name}: unknown logo source "${c.logo.source}"`);
      continue;
    }
    let res;
    try {
      res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    } catch (e) {
      problems.push(`${c.name}: ${url} → ${e.message}`);
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) {
      problems.push(`${c.name}: ${url} → ${res.status} ${type}`);
      continue;
    }
    writeFileSync(rawFile, Buffer.from(await res.arrayBuffer()));
    console.error(`fetched ${c.slug}`);
  }
  if (!existsSync(rawFile)) {
    problems.push(`${c.name}: missing .logo-wall/raw-logos/${c.slug}.png`);
    continue;
  }
  const err = process_(c.slug, rawFile);
  if (err) problems.push(err);
}

if (!CHECK) {
  const sorted = Object.fromEntries(Object.entries(rasters).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(RASTERS, JSON.stringify(sorted, null, 2) + "\n");
} else {
  const known = existsSync(RASTERS) ? JSON.parse(readFileSync(RASTERS, "utf8")) : {};
  for (const c of companies) {
    if (!["simple-icons", "none"].includes(c.logo.source) && !known[c.slug]) {
      problems.push(`${c.name}: no size in rasters.json — run fetch-logos without --check`);
    }
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.error(`${companies.length} logos OK`);
