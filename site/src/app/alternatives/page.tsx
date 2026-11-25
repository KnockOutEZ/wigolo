import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import styles from "@/components/alternatives/Alternatives.module.css";
import { ALTERNATIVES } from "@/content/alternatives";
import { breadcrumbs, graph } from "@/lib/jsonld";
import { BASE_PATH, SOCIAL_IMAGE } from "@/lib/site";

const TITLE = "Free, open-source alternatives to Firecrawl, Exa and Tavily";
const DESCRIPTION =
  "How wigolo compares with the hosted web APIs for AI agents: the same search, scrape, crawl and research jobs, run locally with no API key and no per-query bill.";

export const metadata: Metadata = {
  title: { absolute: `${TITLE} · wigolo` },
  description: DESCRIPTION,
  alternates: { canonical: "/alternatives/" },
  openGraph: {
    type: "website",
    siteName: "wigolo",
    title: TITLE,
    description: DESCRIPTION,
    url: "/alternatives/",
    images: [SOCIAL_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [SOCIAL_IMAGE.url],
  },
};

export default function AlternativesIndex() {
  const ld = graph(
    breadcrumbs([
      { name: "wigolo", path: "/" },
      { name: "Alternatives", path: "/alternatives/" },
    ]),
  );
  return (
    <>
      <Nav />
      <main className={styles.main}>
        <div className="container">
          <span className="eyebrow">Alternatives</span>
          <h1 className={styles.h1}>{TITLE}</h1>
          <p className={styles.lede}>
            Firecrawl, Exa and Tavily sell web search, scraping and research to AI agents by the
            request. wigolo does the same jobs on your own machine — free, keyless, and open source.
          </p>
          <section className={styles.section}>
            <div className={styles.cards}>
              {ALTERNATIVES.map((a) => (
                <a key={a.slug} className={styles.card} href={`${BASE_PATH}/alternatives/${a.slug}/`}>
                  <div className={styles.cardTitle}>wigolo vs {a.name}</div>
                  <p className={styles.cardBody}>{a.lede}</p>
                </a>
              ))}
            </div>
          </section>
        </div>
      </main>
      <Footer />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ld }} />
    </>
  );
}
