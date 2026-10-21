import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import alt from "@/components/alternatives/Alternatives.module.css";
import { starCount } from "@/lib/logo-wall";
import { asset, BASE_PATH, GH, SOCIAL_IMAGE } from "@/lib/site";
import { SPONSORS, logoHeight, logoWidth, sponsorGoPath } from "@/lib/sponsors";
import { compact, npmMonthlyDownloads } from "@/lib/stats";
import styles from "./sponsors.module.css";

const TITLE = "Sponsor wigolo";
const DESCRIPTION =
  "Put your company in front of the developers wiring web search into their AI agents: the wigolo README, docs, site and every release, with reach measured and shared.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/sponsors/" },
  openGraph: { type: "website", siteName: "wigolo", title: TITLE, description: DESCRIPTION, url: "/sponsors/", images: [SOCIAL_IMAGE] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [SOCIAL_IMAGE.url] },
};

const SHARE_URL = process.env.NEXT_PUBLIC_UMAMI_SHARE_URL ?? "";

const PLACEMENTS = [
  ["README header", "a logo above the fold on the GitHub repository page, where most visitors land."],
  ["README sponsors section", "logo and a one-line description."],
  ["Website", "a \"sponsored by\" line near the top of the homepage, under the logo wall, and a card in its sponsors section."],
  ["Docs", "where it fits your product, a labeled setup example in the docs and examples."],
  ["Releases", "a credit at the top of every GitHub release's notes."],
  ["SPONSORS.md", "the same card and description."],
];

export default async function SponsorsPage() {
  const [stars, downloads] = await Promise.all([starCount(), npmMonthlyDownloads()]);
  const stats = [
    { value: `${stars.toLocaleString("en-US")}+`, label: "GitHub stars" },
    ...(downloads ? [{ value: compact(downloads), label: "npm downloads / month" }] : []),
    { value: "9", label: "agents wired in one command" },
  ];

  return (
    <>
      <Nav />
      <main className={alt.main}>
        <div className="container">
          <span className="eyebrow">Sponsorship</span>
          <h1 className={alt.h1}>Sponsor wigolo</h1>
          <p className={alt.lede}>
            wigolo is free for everyone and stays that way. Sponsors keep it maintained — and get their
            name in front of the developers wiring web search into their AI agents.
          </p>

          <section className={alt.section}>
            <div className={styles.stats}>
              {stats.map((s) => (
                <div key={s.label} className={styles.stat}>
                  <div className={styles.value}>{s.value}</div>
                  <div className={styles.label}>{s.label}</div>
                </div>
              ))}
            </div>
            <p className={alt.foot}>
              Figures refresh with every site build: stars from the GitHub API, downloads across the
              wigolo npm packages over the last 30 days.
              {SHARE_URL && (
                <>
                  {" "}
                  <a className={styles.link} href={SHARE_URL} target="_blank" rel="noreferrer">
                    Live site traffic →
                  </a>
                </>
              )}
            </p>
          </section>

          <section className={alt.section}>
            <h2 className={alt.h2}>Where sponsors appear</h2>
            <ul className={styles.list}>
              {PLACEMENTS.map(([name, text]) => (
                <li key={name}>
                  <strong>{name}</strong> — {text}
                </li>
              ))}
            </ul>
          </section>

          <section className={alt.section}>
            <h2 className={alt.h2}>How reach is measured</h2>
            <p className={alt.prose}>
              Every sponsor link goes through a short hop on this site that counts the click and tags it
              with the placement it came from, then forwards with a <code>utm_content</code>{" "}
              tag — so
              clicks from the README, the docs and releases show up separately in your analytics and in
              ours. The site&apos;s analytics are anonymous and cookieless.
              Figures are shared on request.
            </p>
          </section>

          <section className={alt.section}>
            <h2 className={alt.h2}>What stays independent</h2>
            <ul className={styles.list}>
              <li>
                <strong>The roadmap and the code.</strong> Nothing is built, ranked or benchmarked
                differently because of sponsorship.
              </li>
              <li>
                <strong>Non-exclusive.</strong> Other sponsors are welcome, including ones in the same
                market.
              </li>
              <li>
                <strong>No endorsement implied</strong> in either direction — a logo is a thank-you.
              </li>
            </ul>
            <p className={alt.prose} style={{ marginTop: 18 }}>
              Amounts and duration are worked out per conversation; companies are invoiced directly and
              annual sponsors get a commercial license included. Full terms in{" "}
              <a className={styles.link} href={`${GH}/blob/main/SPONSORS.md`}>SPONSORS.md</a>.
            </p>
          </section>

          {SPONSORS.length > 0 && (
            <section className={alt.section}>
              <h2 className={alt.h2}>Current sponsors</h2>
              {SPONSORS.map((s) => (
                <div key={s.slug} className={styles.sponsor}>
                  <a href={asset(sponsorGoPath(s.slug, "sponsors-page"))} rel="sponsored noopener" aria-label={s.name}>
                    <img className={styles.sponsorLogo} src={asset(s.logo.light)} alt={s.name} width={logoWidth(s, 30)} height={logoHeight(s, 30)} style={{ height: logoHeight(s, 30) }} loading="lazy" decoding="async" />
                  </a>
                  <p className={styles.sponsorText}>{s.description}</p>
                </div>
              ))}
            </section>
          )}

          <section className={alt.section}>
            <h2 className={alt.h2}>Get in touch</h2>
            <p className={alt.prose}>
              Email goes straight to the developer who writes the code, not a sales inbox. A one-off
              contribution is just as welcome.
            </p>
            <div className={styles.contact}>
              <a className="btn btn-primary" href="mailto:ktowhid20@gmail.com?subject=Sponsoring%20wigolo" data-track="sponsor_contact" data-track-location="sponsors-page">
                ktowhid20@gmail.com
              </a>
              <a className="btn btn-ghost" href="https://buymeacoffee.com/knockoutez">
                Buy me a coffee
              </a>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
