import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Inline from "@/components/alternatives/Inline";
import styles from "@/components/alternatives/Alternatives.module.css";
import { ALTERNATIVES, CHECKED, getAlternative } from "@/content/alternatives";
import { breadcrumbs, faqPage, graph } from "@/lib/jsonld";
import { BASE_PATH, SOCIAL_IMAGE } from "@/lib/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return ALTERNATIVES.map((a) => ({ slug: a.slug }));
}

type Props = { params: Promise<{ slug: string }> };


export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const alt = getAlternative((await params).slug);
  if (!alt) notFound();
  const url = `/alternatives/${alt.slug}/`;
  return {
    title: { absolute: `${alt.title} · wigolo` },
    description: alt.description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      siteName: "wigolo",
      title: alt.title,
      description: alt.description,
      url,
      images: [SOCIAL_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: alt.title,
      description: alt.description,
      images: [SOCIAL_IMAGE.url],
    },
  };
}

export default async function AlternativePage({ params }: Props) {
  const alt = getAlternative((await params).slug);
  if (!alt) notFound();
  const others = ALTERNATIVES.filter((a) => a.slug !== alt.slug);
  const ld = graph(
    breadcrumbs([
      { name: "wigolo", path: "/" },
      { name: "Alternatives", path: "/alternatives/" },
      { name: `${alt.name} alternative`, path: `/alternatives/${alt.slug}/` },
    ]),
    faqPage(alt.faq),
  );

  return (
    <>
      <Nav />
      <main className={styles.main}>
        <div className="container">
          <nav className={styles.crumbs} aria-label="Breadcrumb">
            <a href={`${BASE_PATH}/`}>wigolo</a> / <a href={`${BASE_PATH}/alternatives/`}>alternatives</a> /{" "}
            {alt.name.toLowerCase()}
          </nav>
          <span className="eyebrow">{alt.name} alternative</span>
          <h1 className={styles.h1}>{alt.h1}</h1>
          <p className={styles.lede}>{alt.lede}</p>
          <div className={styles.ctas}>
            <code className={styles.cmd}>npx wigolo init --agents=claude-code</code>
            <a className="btn btn-primary" href={`${BASE_PATH}/docs/getting-started/`}>
              Get started
            </a>
            <a className="btn btn-ghost" href="https://github.com/KnockOutEZ/wigolo">
              Star on GitHub
            </a>
          </div>

          <section className={styles.section}>
            <h2 className={styles.h2}>wigolo and {alt.name}, side by side</h2>
            <p className={styles.prose}>{alt.about}</p>
            <p className={styles.prose}>
              wigolo is a free, open-source server that gives any AI agent the same web jobs from your
              own machine: search across 18 engines, fetch, crawl, extract, a persistent local cache,
              find-similar, research and autonomous gathering. There is no account and no metered bill.
            </p>
          </section>

          <section className={styles.section}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <td />
                    <th scope="col" className={`${styles.colHead} ${styles.usHead}`}>wigolo</th>
                    <th scope="col" className={styles.colHead}>{alt.name}</th>
                  </tr>
                </thead>
                <tbody>
                  {alt.rows.map((r) => (
                    <tr key={r.label}>
                      <th scope="row" className={styles.rowLabel}>{r.label}</th>
                      <td className={styles.us}><Inline text={r.wigolo} /></td>
                      <td className={styles.them}><Inline text={r.them} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={styles.foot}>
              {alt.name} details as published by {alt.name}, checked {CHECKED}:{" "}
              {alt.sources.map((s, i) => (
                <span key={s.url}>
                  {i > 0 && ", "}
                  <a href={s.url} rel="nofollow noopener" target="_blank">{s.label}</a>
                </span>
              ))}
              . Check their site for current terms.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.h2}>Moving from {alt.name}</h2>
            <p className={styles.prose}>
              Each {alt.name} endpoint has a wigolo tool that does the same job. Wire wigolo into your
              agent over MCP and it discovers these tools on its own; frameworks and scripts use the
              REST API or the TypeScript and Python SDKs.
            </p>
            <div className={styles.tableWrap} style={{ marginTop: 24 }}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col" className={styles.colHead}>{alt.name}</th>
                    <th scope="col" className={`${styles.colHead} ${styles.usHead}`}>wigolo tool</th>
                    <th scope="col" className={styles.colHead}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {alt.mapping.map((m) => (
                    <tr key={m.theirs}>
                      <td className={styles.them}><code className={styles.code}>{m.theirs}</code></td>
                      <td className={styles.us}><code className={styles.code}>{m.wigolo}</code></td>
                      <td className={styles.them}>{m.note ? <Inline text={m.note} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={styles.prose} style={{ marginTop: 20 }}>
              Full parameters for every tool: <a href={`${BASE_PATH}/docs/tools/`} style={{ textDecoration: "underline" }}>tool reference</a>.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.h2}>Questions</h2>
            <div className={styles.faq}>
              {alt.faq.map((f) => (
                <div key={f.q} className={styles.qa}>
                  <h3 className={styles.q}>{f.q}</h3>
                  <p className={styles.a}><Inline text={f.a} /></p>
                </div>
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.h2}>More comparisons</h2>
            <div className={styles.more}>
              {others.map((o) => (
                <a key={o.slug} href={`${BASE_PATH}/alternatives/${o.slug}/`}>{o.name} alternative</a>
              ))}
              <a href={`${BASE_PATH}/alternatives/`}>All alternatives</a>
            </div>
          </section>
        </div>
      </main>
      <Footer />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ld }} />
    </>
  );
}
