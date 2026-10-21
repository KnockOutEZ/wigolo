import { SITE_URL, GH } from "@/lib/site";

// schema.org blocks shared across pages. Only facts that are true of the
// project today — no ratings, reviews or download counts we can't source.

const SAME_AS = [
  GH,
  "https://www.npmjs.com/package/wigolo",
  "https://pypi.org/project/wigolo/",
  "https://x.com/yourtowhid",
  "https://discord.gg/BkUUgz2bNF",
];

export const organization = () => ({
  "@type": "Organization",
  "@id": `${SITE_URL}/#org`,
  name: "wigolo",
  url: `${SITE_URL}/`,
  logo: `${SITE_URL}/wigolo/wigolo-icon.png`,
  sameAs: SAME_AS,
});

export const website = () => ({
  "@type": "WebSite",
  "@id": `${SITE_URL}/#website`,
  name: "wigolo",
  url: `${SITE_URL}/`,
  publisher: { "@id": `${SITE_URL}/#org` },
});

export const softwareApplication = (description: string) => ({
  "@type": "SoftwareApplication",
  "@id": `${SITE_URL}/#app`,
  name: "wigolo",
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "Web search, scraping and crawling for AI agents",
  operatingSystem: "macOS, Linux, Windows",
  description,
  url: `${SITE_URL}/`,
  downloadUrl: "https://www.npmjs.com/package/wigolo",
  installUrl: `${SITE_URL}/docs/getting-started/`,
  softwareVersion: "0.2.x (public beta)",
  releaseNotes: `${GH}/releases`,
  license: "https://www.gnu.org/licenses/agpl-3.0.html",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author: { "@type": "Person", name: "Towhid Khan", url: "https://github.com/KnockOutEZ" },
  publisher: { "@id": `${SITE_URL}/#org` },
  sameAs: SAME_AS,
});

export const breadcrumbs = (items: { name: string; path: string }[]) => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map((it, i) => ({
    "@type": "ListItem",
    position: i + 1,
    name: it.name,
    item: `${SITE_URL}${it.path}`,
  })),
});

export const faqPage = (qa: { q: string; a: string }[]) => ({
  "@type": "FAQPage",
  mainEntity: qa.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a.replace(/`/g, "") },
  })),
});

/** One <script type="application/ld+json"> payload for a list of nodes. */
export const graph = (...nodes: object[]) =>
  JSON.stringify({ "@context": "https://schema.org", "@graph": nodes }).replace(/</g, "\\u003c");
