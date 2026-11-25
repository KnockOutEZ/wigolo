import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

// One group for every crawler, search and AI alike (a bot matching its own
// group would skip this one). Everything is open except the sponsor hops:
// they are redirects, not content, and a crawler fetching one would count as
// a click — inflating what we report to sponsors.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/go/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
