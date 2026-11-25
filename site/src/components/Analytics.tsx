"use client";

import Script from "next/script";
import { useEffect } from "react";
import { UMAMI_DOMAINS, UMAMI_ID, UMAMI_SRC, analyticsEnabled, track } from "@/lib/analytics";

/**
 * Loads Umami after hydration (never competes with first paint) and turns any
 * click on an element with `data-track="<event>"` into that event, with its
 * `data-track-*` attributes as properties. Page views, including client-side
 * route changes in the docs, are counted by the tag itself.
 */
export default function Analytics() {
  useEffect(() => {
    if (!analyticsEnabled()) return;
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest<HTMLElement>("[data-track]");
      if (!el) return;
      const data: Record<string, string> = {};
      for (const [k, v] of Object.entries(el.dataset)) {
        if (k.startsWith("track") && k !== "track" && v) {
          data[k.slice(5).replace(/^./, (c) => c.toLowerCase())] = v;
        }
      }
      void track(el.dataset.track!, data);
    };
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  if (!analyticsEnabled()) return null;
  return (
    <Script
      src={UMAMI_SRC}
      data-website-id={UMAMI_ID}
      data-domains={UMAMI_DOMAINS}
      data-do-not-track="true"
      data-exclude-search="true"
      strategy="afterInteractive"
    />
  );
}
