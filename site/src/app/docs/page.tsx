import type { Metadata } from "next";
import DocShell from "@/components/docs/DocShell";
import { assertDocsInSync, getDoc } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "wigolo documentation: install, wire an agent, the 10 tools, the REST API, SDKs, self-hosting, and more. Local-first web intelligence for AI agents.",
  alternates: { canonical: "/docs" },
};

export default function DocsIndexPage() {
  // Fail the build loudly if docs/ and the nav list drift apart.
  assertDocsInSync();
  const doc = getDoc("index");
  return <DocShell doc={doc} />;
}
