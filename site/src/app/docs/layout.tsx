import type { ReactNode } from "react";
import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import StaticSearchDialog from "@/components/docs/SearchDialog";
import { source } from "@/lib/source";
import "./docs.css";

// Docs chrome only: the provider (search, no theme switching — the site is
// light-only) and Tailwind-based docs CSS never mount on marketing pages.
// Links out of /docs are plain <a>, so a full page load drops this CSS.
export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }} search={{ SearchDialog: StaticSearchDialog }}>
      <Nav />
      <DocsLayout
        tree={source.pageTree}
        // Stays enabled: on small screens it carries the sidebar menu button.
        nav={{ title: "Docs", url: "/docs/" }}
        themeSwitch={{ enabled: false }}
        tabs={false}
        containerProps={{ className: "wigolo-docs" }}
      >
        {children}
      </DocsLayout>
      <Footer />
    </RootProvider>
  );
}
