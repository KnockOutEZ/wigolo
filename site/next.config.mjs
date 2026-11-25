import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Static export for GitHub Pages (custom domain wigolo.app, served from the
// root). NEXT_PUBLIC_BASE_PATH stays supported for sub-path hosting; unset in
// production. `.mjs` because fumadocs-mdx is ESM-only.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "export",
  basePath: basePath || undefined,
  images: { unoptimized: true },
  trailingSlash: true,
  turbopack: {
    root: __dirname,
  },
};

export default createMDX()(nextConfig);
