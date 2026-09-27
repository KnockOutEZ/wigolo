# Sponsors

**wigolo is free for everyone.**

There is no paid tier, no metered plan, and no feature held back for people who
pay. The core tools need no API keys and send nothing to a third party. That is
the whole point of the project, and sponsorship is what makes it sustainable to
keep it that way.

## Thank you

### TestMu AI

<a href="https://wigolo.app/go/testmu/?ref=sponsors-page">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="assets/sponsors/testmu-ai-dark.svg">
<img alt="TestMu AI" src="assets/sponsors/testmu-ai.svg" height="40">
</picture>
</a>

[TestMu AI](https://wigolo.app/go/testmu/?ref=sponsors-page)
(formerly LambdaTest) is the world's first full-stack agentic AI quality
engineering platform, trusted by 18,000+ enterprises.

TestMu AI is wigolo's first sponsor. Thanks for the support.


### Helodata

<a href="https://wigolo.app/go/helodata/?ref=sponsors-page">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="assets/sponsors/helodata-dark.svg">
<img alt="Helodata" src="assets/sponsors/helodata.svg" height="40">
</picture>
</a>

[Helodata](https://wigolo.app/go/helodata/?ref=sponsors-page) is proxy
infrastructure for AI applications, web scraping and automation: residential,
ISP, mobile and datacenter proxies across 195+ countries and regions.

## Want to sponsor wigolo?

There is room for more companies and individuals alongside the sponsors above.
If keeping a free, keyless, local-first web layer maintained is worth something
to you or your team, I'd love to hear from you.

**Get in touch: [ktowhid20@gmail.com](mailto:ktowhid20@gmail.com)** — it goes
directly to the developer who writes the code, not a sales inbox.

A one-off contribution is just as welcome as a sponsorship, via
[Buy Me a Coffee](https://buymeacoffee.com/knockoutez).

Companies are invoiced directly and paid by bank transfer, so there's no
platform account to set up on your side and nothing skimmed off the top by a
middleman. Whatever billing details your finance team needs on the invoice, just
say and I'll put them on it.

### What sponsorship funds

Sponsorship goes into the work itself: maintenance and releases across macOS,
Linux, and Windows; search and extraction quality; CI and benchmarking; and the
time to answer issues from people running wigolo in production.

### What a sponsor gets

- A logo in the **README header**, above the fold on the repository page,
  plus a logo and one-line description in the README sponsors section near
  the end.
- On the **[project website](https://wigolo.app/)** homepage: a "sponsored by"
  line under the logo wall near the top, and a card in the sponsors section.
  Also on the [sponsor page](https://wigolo.app/sponsors/).
- A credit at the top of **every GitHub release**'s notes.
- Where it fits the sponsor's product, a **sponsored setup example** in the
  docs and examples — for instance the model provider in the answer-synthesis
  setup, or the proxy in the proxy setup — clearly labeled as sponsored and
  always paired with how to use any other provider instead.
- The same placement on this page.
- A link on every placement, with its reach measured — figures available on
  request, see [Measurement](#measurement) below.
- Annual sponsors get a commercial license included; see
  [LICENSING.md](LICENSING.md).

### How sponsorship and the project stay separate

Sponsors support the work without steering it. That protects them as much as it
protects users: nobody has to wonder whether a ranking, a benchmark, or a doc
was shaped by who paid, and a sponsor is never on the hook for what the project
ships. These are the standing terms for every sponsor, so they're the same
conversation each time.

- **The roadmap and the code stay independent.** Nothing is built, ranked,
  prioritised, or benchmarked differently because of sponsorship, and a
  sponsor's own service gets no special standing in search results, adapters,
  defaults, or recommendations. A sponsor may appear in a setup example in the
  docs; that example is labeled as sponsored and shows how to swap in any
  other provider, and nothing is ever marked as the recommended choice.
- **Non-exclusive.** Other sponsors are welcome, including ones in the same
  market.
- **The sponsors section stays the project's to run** — its placements, tiers,
  and who appears in it.
- **No claim over the project.** No CLA, no copyright assignment, and no limit
  on how wigolo is licensed or commercialised, now or later.
- **No endorsement implied in either direction.** A logo here is a thank-you,
  not a technical endorsement of wigolo by the sponsor, or of the sponsor by
  wigolo.

Amounts and duration are worked out per conversation — reach out and we'll find
something that fits.

## Measurement

Sponsor placements are measured, so there are real figures behind them rather
than a vague claim of exposure. The method is public here; the numbers are
shared on request.

Every sponsor link on every surface points at a **`/go/<slug>/` link on the
wigolo site** rather than straight at the sponsor. That hop counts the click,
then forwards to the sponsor's own URL with a `utm_content` tag naming the
placement it came from, so each placement can be told apart.

What is measured:

- **Clicks, by placement, over time** — each hop records a `sponsor_click`
  event (sponsor and placement) in the site's analytics.
- **Reach, as a proxy for impressions** — repository traffic, the site's
  pageviews, and Google Search Console impressions for the site's pages. README
  impressions can't be counted accurately, because GitHub proxies and caches
  images; repo views are the stand-in, and they're described as exactly that.
- **What is never collected** — no cookies, no local storage, no personal
  data, and nothing that identifies an individual visitor. The site uses
  cookieless analytics (Umami) and honours Do Not Track. The wigolo tool itself
  sends nothing to the site; this covers the website only.

The implementation is in [`site/src/lib/sponsors.ts`](site/src/lib/sponsors.ts),
[`site/src/lib/analytics.ts`](site/src/lib/analytics.ts) and the interstitial in
[`site/src/app/go/[slug]/`](site/src/app/go/) — read it if you'd like to know
exactly what is recorded.

## Notes for contributors

- Sponsors live in one place: the `SPONSORS` array in
  [`site/src/lib/sponsors.ts`](site/src/lib/sponsors.ts). Adding one there
  generates its `/go/<slug>/` page and its card on the website.
- Logos go in `assets/sponsors/` (for the README) and `site/public/sponsors/`
  (for the site), with a **light and a dark variant** — a single-theme logo goes
  invisible on one of GitHub's two themes.
- Sponsor links must always go through `/go/<slug>/`, never directly to the
  sponsor, or the click goes uncounted and the placement becomes unreportable.
- The tracked-link contract is covered by
  [`tests/unit/sponsors-links.test.ts`](tests/unit/sponsors-links.test.ts).
