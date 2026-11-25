import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  EditOnGitHub,
} from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents, { createRelativeLink } from "fumadocs-ui/mdx";
import { source } from "@/lib/source";
import { GH, SOCIAL_IMAGE } from "@/lib/site";

// Static export: every docs page is built; anything else 404s.
export const dynamicParams = false;

export function generateStaticParams() {
  return source.generateParams();
}

type Props = { params: Promise<{ slug?: string[] }> };


/** Where the page's text lives in the repo, for "Edit on GitHub". */
function repoFile(slugs: string[]): string {
  if (slugs.length === 0) return "docs/README.md";
  if (slugs[0] === "examples") {
    return slugs.length === 1 ? "examples/README.md" : `examples/${slugs[1]}/README.md`;
  }
  return `docs/${slugs[0]}.md`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug = [] } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const url = `${page.url}/`;
  return {
    title: slug.length === 0 ? "Documentation" : page.data.title,
    description: page.data.description,
    alternates: { canonical: url },
    // Next replaces (not merges) nested metadata objects, so the shared
    // social image and card type have to be restated here.
    openGraph: {
      type: "article",
      siteName: "wigolo",
      title: page.data.title,
      description: page.data.description,
      url,
      images: [SOCIAL_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: page.data.title,
      description: page.data.description,
      images: [SOCIAL_IMAGE.url],
    },
  };
}

export default async function DocPage({ params }: Props) {
  const { slug = [] } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={page.data.full} tableOfContent={{ style: "clerk" }}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, a: createRelativeLink(source, page) }} />
      </DocsBody>
      <EditOnGitHub href={`${GH}/edit/main/${repoFile(slug)}`} />
    </DocsPage>
  );
}
