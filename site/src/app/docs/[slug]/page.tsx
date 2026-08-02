import type { Metadata } from "next";
import { notFound } from "next/navigation";
import DocShell from "@/components/docs/DocShell";
import { DOCS_NAV, getDoc, getDocSlugs } from "@/lib/docs";

// Static export: only the slugs returned here are built; anything else 404s.
export const dynamicParams = false;

export function generateStaticParams() {
  return getDocSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const meta = DOCS_NAV.find((d) => d.slug === slug);
  if (!meta) return {};
  return {
    title: meta.title,
    description: meta.blurb,
    alternates: { canonical: `/docs/${slug}` },
  };
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!getDocSlugs().includes(slug)) notFound();
  const doc = getDoc(slug);
  return <DocShell doc={doc} />;
}
