import type { MetadataRoute } from "next";
import { ALTERNATIVES } from "@/content/alternatives";
import { lastModified } from "@/lib/lastmod";
import { source } from "@/lib/source";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

/** Where a docs page's text lives in the repo. */
function repoFile(slugs: string[]): string {
  if (slugs.length === 0) return "docs/README.md";
  if (slugs[0] === "examples") return slugs.length === 1 ? "examples/README.md" : `examples/${slugs[1]}/README.md`;
  return `docs/${slugs[0]}.md`;
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, lastModified: lastModified("site/src"), priority: 1 },
    { url: `${SITE_URL}/sponsors/`, lastModified: lastModified("site/src/app/sponsors", "site/src/lib/sponsors.ts"), priority: 0.5 },
    { url: `${SITE_URL}/alternatives/`, lastModified: lastModified("site/src/content/alternatives.ts"), priority: 0.8 },
    ...ALTERNATIVES.map((a) => ({
      url: `${SITE_URL}/alternatives/${a.slug}/`,
      lastModified: lastModified("site/src/content/alternatives.ts"),
      priority: 0.8,
    })),
    ...source.getPages().map((p) => ({
      url: `${SITE_URL}${p.url}/`,
      lastModified: lastModified(repoFile(p.slugs)),
      priority: p.slugs.length === 0 ? 0.9 : p.slugs[0] === "examples" ? 0.6 : 0.7,
    })),
  ];
}
