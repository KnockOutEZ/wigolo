export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const GH = "https://github.com/KnockOutEZ/wigolo";

export const FEEDBACK_LINKS = {
  bug: `${GH}/issues/new?template=bug_report.yml`,
  feature: `${GH}/issues/new?template=feature_request.yml`,
  discussions: `${GH}/discussions`,
};

/** Prefix a /public asset path with the configured base path (GitHub Pages). */
export const asset = (path: string) => `${BASE_PATH}${path}`;

/** Shared Open Graph / Twitter image (its real pixel size — 2:1 renders on every major card). */
export const SOCIAL_IMAGE = { url: "/wigolo/wigolo-social.png", width: 2560, height: 1280 } as const;
