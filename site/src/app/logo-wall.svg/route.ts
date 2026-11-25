import { buildWall } from "@/lib/logo-wall";

export const dynamic = "force-static";

// One sprite for every simple-icons mark on the logo wall. Served as a static
// file so ~40 KB of path data stays out of the HTML and the RSC payload.
export function GET() {
  const symbols = buildWall()
    .symbols.map(
      (s) =>
        `<symbol id="${s.symbolId}" viewBox="${s.viewBox}"><path d="${s.path}" fill="currentColor"/></symbol>`,
    )
    .join("");
  return new Response(`<svg xmlns="http://www.w3.org/2000/svg">${symbols}</svg>`, {
    headers: { "Content-Type": "image/svg+xml; charset=utf-8" },
  });
}
