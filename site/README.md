# wigolo landing site

Next.js static site for [wigolo](https://github.com/KnockOutEZ/wigolo), deployed to GitHub Pages (custom domain `wigolo.app`, DNS on Cloudflare) by `.github/workflows/site.yml` on pushes to `main` that touch `site/`, `docs/` or `examples/`.

```bash
npm ci
npm run dev        # local dev at localhost:3000
npm run build      # static export to out/
```

Environment (set by the Pages workflow; optional locally):

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_BASE_PATH` | Optional path prefix for hosting under a sub-path; unset in production (the site serves from the domain root) |
| `NEXT_PUBLIC_SITE_URL` | Canonical URL for metadata/OG (`https://wigolo.app`) |
| `NEXT_PUBLIC_WEB3FORMS_KEY` | Access key for the quick-feedback form (web3forms.com). Unset → the form hides and only the GitHub links show. |

All `/public` asset references go through `asset()` from `src/lib/site.ts` so they keep working if a base path is ever set. Fonts are open-licensed and self-hosted at build time via `next/font` (Bricolage Grotesque · Instrument Sans · Azeret Mono).

## Logo wall

The "Starred by … developers, including engineers at" section is driven by `src/content/logo-wall/companies.json` — a hand-curated list, nothing is added automatically.

```bash
npm run logos:mine     # pull stargazers + forks (GitHub GraphQL, needs `gh auth login` or GITHUB_TOKEN)
                       # → .logo-wall/candidates.json, ranked by people per company (gitignored: holds logins)
npm run logos:fetch    # download + normalise raster logos into public/logos/, write rasters.json
npm run logos:check    # verify every entry has a logo (CI runs this before build)
```

Each entry: `tier` 1 (top row, scrolls left) or 2 (bottom row, scrolls right); `evidence` is `verified` when GitHub attests the link (public org membership, org-owned fork, or a profile email on the company domain) and `self-reported` when it rests on the free-text company field alone; `display` is `icon+name`, `wordmark` (the logo already spells the name) or `name` (text only); `logo.source` is `simple-icons` (inline SVG, preferred), `github-avatar`, `favicon`, `file` (drop a PNG at `.logo-wall/raw-logos/<slug>.png`) or `none`. Rasters are converted to monochrome silhouettes so every logo takes the same treatment. `npm run logos:mine -- --offline` re-ranks the cached pull without calling the API.

Dependencies it adds: `simple-icons` (CC0 brand SVGs, build-time only), `svg-path-bbox` (crops wordmarks to their glyph), and dev-only `pngjs` (raster normalisation) and `vitest` (`npm test`).

## Docs

`/docs` renders the repo's own `docs/*.md` and `examples/*/README.md` — edit those, not anything under `site/`. `scripts/sync-content.mjs` runs before `dev`/`build`: it copies them into the gitignored `content/docs/`, adds frontmatter (title from the page's `# ` heading, description from the index table), orders the sidebar from the `docs/README.md` and `examples/README.md` tables, and rewrites links (doc-to-doc stays on the site, anything else goes to GitHub). The build fails if a page exists without a table row, or the reverse.

Built with Fumadocs (`fumadocs-core`, `fumadocs-ui`, `fumadocs-mdx`) and Tailwind v4 (`tailwindcss`, `@tailwindcss/postcss`), both loaded only on `/docs`. Search is a static index (`/search.json`, fetched on first search). `/llms.txt` and `/llms-full.txt` are generated from the same pages, led by `src/content/llms-preamble.md`.

## Analytics

[Umami](https://umami.is): cookieless, no personal data, no consent banner. Loads only when `NEXT_PUBLIC_UMAMI_ID` is set (the Pages workflow reads the `UMAMI_WEBSITE_ID` repo variable), counts only on `wigolo.app`, and honours Do Not Track. `NEXT_PUBLIC_UMAMI_SRC` points the tag at a self-hosted Umami instead of Umami Cloud. Logic lives in `src/lib/analytics.ts`, the loader in `src/components/Analytics.tsx`.

- **Events:** page views (automatic, including client-side docs navigation); `copy_install`, `cta_click` and `github_click` with a `location` property; `sponsor_click` with `sponsor` and `placement` from every `/go/` hop. Any element gets click tracking with `data-track="<event>"` plus `data-track-<property>` attributes.
- **Sponsor reporting:** the public share URL lives in the `UMAMI_SHARE_URL` repo variable and is linked from `/sponsors/` as live traffic; filter events by `sponsor_click` and break down by `placement`.
- **Search data** (queries, impressions, rankings) comes from Google Search Console, not the site.
