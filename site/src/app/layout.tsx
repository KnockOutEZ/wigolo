import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, Azeret_Mono } from "next/font/google";
import { asset, SITE_URL } from "@/lib/site";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-display",
});
const body = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-body",
});
const mono = Azeret_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
});

const TITLE = "wigolo — local-first web intelligence for AI agents";
const DESCRIPTION =
  "Free, open-source server that gives any AI agent real web powers — search across 18 engines, fetch, crawl, extract, cache, and research. In your editor over MCP, in your framework through an SDK, or in your self-hosted stack over REST. Runs on your machine: no API keys, no cloud, no metered bill. Public beta.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s · wigolo",
  },
  description: DESCRIPTION,
  keywords: [
    "MCP server",
    "web search for AI agents",
    "local-first",
    "Claude Code web search",
    "Cursor MCP",
    "Tavily alternative",
    "Exa alternative",
    "Firecrawl alternative",
    "web scraping for LLMs",
    "AI agent tools",
    "open source",
    "no API key",
  ],
  authors: [{ name: "Towhid Khan", url: "https://github.com/KnockOutEZ" }],
  creator: "Towhid Khan",
  alternates: { canonical: "/" },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  icons: { icon: asset("/wigolo/wigolo-icon.png") },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "wigolo",
    title: TITLE,
    description:
      "Local-first web intelligence over MCP. No keys, no cloud, no metered bill. Public beta.",
    // Plain public path: metadataBase already carries the base path —
    // asset() here would double-prefix it.
    images: [{ url: "/wigolo/wigolo-social.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description:
      "Local-first web intelligence over MCP. No keys, no cloud, no metered bill. Public beta.",
    images: ["/wigolo/wigolo-social.png"],
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "wigolo",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  description: DESCRIPTION,
  url: SITE_URL,
  downloadUrl: "https://www.npmjs.com/package/wigolo",
  softwareVersion: "0.2.x (public beta)",
  releaseNotes: "https://github.com/KnockOutEZ/wigolo/releases",
  license: "https://www.gnu.org/licenses/agpl-3.0.html",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author: {
    "@type": "Person",
    name: "Towhid Khan",
    url: "https://github.com/KnockOutEZ",
  },
  sameAs: [
    "https://github.com/KnockOutEZ/wigolo",
    "https://www.npmjs.com/package/wigolo",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
