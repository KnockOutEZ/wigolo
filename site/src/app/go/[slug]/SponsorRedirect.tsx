"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { countHit } from "@/lib/goatcounter";
import {
  type Sponsor,
  normalizePlacement,
  sponsorCountPath,
  sponsorTargetUrl,
} from "@/lib/sponsors";
import SponsorCard from "./SponsorCard";

export default function SponsorRedirect({ sponsor }: { sponsor: Sponsor }) {
  // Derived, not stored: the query string is not part of the exported path, so
  // it resolves on the client. Reading it during render keeps the fallback
  // anchor correctly tagged from the first paint — if the visitor clicks it
  // before the counter settles, the placement still travels with them.
  const placement = normalizePlacement(useSearchParams().get("ref"));
  const target = sponsorTargetUrl(sponsor, placement);

  useEffect(() => {
    let cancelled = false;
    countHit(sponsorCountPath(sponsor.slug, placement), sponsor.name).then(() => {
      // `replace` keeps the hop out of history, so Back returns the visitor to
      // wherever they clicked from rather than bouncing them forward again.
      if (!cancelled) window.location.replace(target);
    });
    return () => {
      cancelled = true;
    };
  }, [sponsor.slug, sponsor.name, placement, target]);

  return <SponsorCard sponsor={sponsor} target={target} />;
}
