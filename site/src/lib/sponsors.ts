/**
 * Sponsor registry and the tracked-link layer.
 *
 * Every sponsor link in the README, the site, and the docs points at our own
 * `/go/<slug>/` hop rather than straight at the sponsor. The hop counts the
 * click and then forwards to the sponsor's canonical URL with a `utm_content`
 * tag naming the placement it came from — so a click is attributable to the
 * README vs the landing page in both our numbers and the sponsor's.
 *
 * Framework-free on purpose: this module is imported by the root vitest suite
 * (tests/unit/sponsors-links.test.ts), so it must not pull in React or Next.
 */

/** Where a sponsor link was rendered. A closed set — see `normalizePlacement`. */
export const PLACEMENTS = [
  "readme",
  "readme-top",
  "site-home",
  "site-strip",
  "site-footer",
  "sponsors-page",
  "docs",
  "release",
  "discord",
  "x",
] as const;

export type Placement = (typeof PLACEMENTS)[number];

/** Used when a `?ref=` value is missing or not one we published. */
export const UNKNOWN_PLACEMENT = "unknown";

export interface Sponsor {
  /** URL-safe id; also the `/go/<slug>/` path segment and the counter path. */
  slug: string;
  name: string;
  /** One line, supplied by the sponsor. Rendered verbatim. */
  description: string;
  /** The sponsor's canonical destination, with their own UTMs left intact. */
  url: string;
  /**
   * Logo paths relative to the site's /public and the repo's /assets, plus the
   * file's intrinsic size — logos differ in shape, and the pages reserve space
   * from it so nothing shifts while they load.
   */
  logo: { light: string; dark: string; width: number; height: number };
  /** Human label for how long they've supported the project. */
  since: string;
}

export const SPONSORS: readonly Sponsor[] = [
  {
    slug: "testmu",
    name: "TestMu AI",
    description:
      "TestMu AI (formerly LambdaTest) is the world's first full-stack agentic AI quality engineering platform, trusted by 18,000+ enterprises.",
    url: "https://www.testmuai.com/?utm_source=wigolo&utm_medium=opensourcecollab",
    logo: {
      light: "/sponsors/testmu-ai.svg",
      dark: "/sponsors/testmu-ai-dark.svg",
      width: 513,
      height: 80,
    },
    since: "2026",
  },
  {
    slug: "helodata",
    name: "Helodata",
    description:
      "Helodata is proxy infrastructure for AI applications, web scraping and automation: residential, ISP, mobile and datacenter proxies across 195+ countries and regions.",
    url: "https://helodata.com/?utm_source=wigolo&utm_medium=sponsor",
    logo: {
      light: "/sponsors/helodata.svg",
      dark: "/sponsors/helodata-dark.svg",
      width: 360,
      height: 80,
    },
    since: "2026",
  },
];

export const getSponsor = (slug: string): Sponsor | undefined =>
  SPONSORS.find((s) => s.slug === slug);

/**
 * Coerce an untrusted `?ref=` value to a published placement.
 *
 * The value arrives from the query string, so anyone can put anything there.
 * It ends up in an outbound `utm_content` and in our analytics path, so it is
 * matched against the closed set instead of being reflected as-is.
 */
export const normalizePlacement = (
  ref: string | null | undefined,
): Placement | typeof UNKNOWN_PLACEMENT =>
  (PLACEMENTS as readonly string[]).includes(ref ?? "")
    ? (ref as Placement)
    : UNKNOWN_PLACEMENT;

/**
 * The sponsor's destination, tagged with the placement.
 *
 * Their `utm_source` / `utm_medium` are preserved exactly as delivered; we only
 * add `utm_content`, and only when it isn't already set on their URL.
 */
export const sponsorTargetUrl = (
  sponsor: Sponsor,
  placement: Placement | typeof UNKNOWN_PLACEMENT,
): string => {
  const url = new URL(sponsor.url);
  if (!url.searchParams.has("utm_content")) {
    url.searchParams.set("utm_content", placement);
  }
  return url.toString();
};

/** Site-relative path of the tracked hop, e.g. `/go/testmu/?ref=readme`. */
export const sponsorGoPath = (
  slug: string,
  placement: Placement | typeof UNKNOWN_PLACEMENT,
): string => `/go/${slug}/?ref=${placement}`;

/**
 * Absolute tracked-hop URL, for surfaces rendered outside the site — the
 * README and anything else GitHub serves, where a relative path would resolve
 * against github.com.
 */
export const sponsorGoUrl = (
  slug: string,
  placement: Placement | typeof UNKNOWN_PLACEMENT,
  siteUrl: string,
): string =>
  `${siteUrl.replace(/\/$/, "")}${sponsorGoPath(slug, placement)}`;


/**
 * One markdown line thanking every sponsor, prepended to each GitHub Release's
 * generated notes (see .github/workflows/release.yml). Empty with no sponsors.
 */
export const sponsorReleaseLine = (siteUrl: string): string =>
  SPONSORS.length === 0
    ? ""
    : `**Sponsored by** ${SPONSORS.map(
        (s) => `[${s.name}](${sponsorGoUrl(s.slug, "release", siteUrl)})`,
      ).join(" · ")} — thank you for keeping wigolo free for everyone.`;

/** Every sponsor logo renders at the same height; kept as a helper so call sites stay uniform. */
export const logoHeight = (_sponsor: Sponsor, base: number): number => base;

/** Matching width for `logoHeight`, from the logo's intrinsic aspect ratio. */
export const logoWidth = (sponsor: Sponsor, base: number): number =>
  Math.round((logoHeight(sponsor, base) * sponsor.logo.width) / sponsor.logo.height);
