import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  SPONSORS,
  UNKNOWN_PLACEMENT,
  getSponsor,
  sponsorTargetUrl,
} from "@/lib/sponsors";
import SponsorCard from "./SponsorCard";
import SponsorRedirect from "./SponsorRedirect";

// Static export: only the sponsor slugs returned here are built; anything else 404s.
export const dynamicParams = false;

export function generateStaticParams() {
  return SPONSORS.map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const sponsor = getSponsor(slug);
  if (!sponsor) return {};
  return {
    title: `Continuing to ${sponsor.name}`,
    // A forwarding hop is not a destination: keep it out of the index so it
    // never competes with the sponsor's own pages in search.
    robots: { index: false, follow: false },
  };
}

export default async function SponsorGoPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const sponsor = getSponsor(slug);
  if (!sponsor) notFound();

  // The child reads `?ref=`, which a static export cannot know at build time,
  // so it needs a boundary to suspend against during prerender. The fallback is
  // the same card with an untagged link — that is what ships in the exported
  // HTML, so a visitor with no JS still sees the page and can click through.
  return (
    <Suspense
      fallback={
        <SponsorCard
          sponsor={sponsor}
          target={sponsorTargetUrl(sponsor, UNKNOWN_PLACEMENT)}
        />
      }
    >
      <SponsorRedirect sponsor={sponsor} />
    </Suspense>
  );
}
