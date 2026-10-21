import { defineDocs } from "fumadocs-mdx/macro";
import { loader } from "fumadocs-core/source";

// content/docs is generated from the repo's docs/ and examples/ by
// scripts/sync-content.mjs (predev/prebuild) — edit those, not this folder.
const docs = defineDocs({
  dir: "content/docs",
  docs: {
    files: ["**/*.md"],
    postprocess: { includeProcessedMarkdown: true },
  },
});

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
