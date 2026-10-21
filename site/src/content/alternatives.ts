/**
 * Comparison pages: /alternatives/<slug>/.
 *
 * Every claim about another product is sourced (see `sources`) and dated
 * (`checked`). Keep them factual and current — these pages rank on the
 * other product's name, so an out-of-date price is the first thing a reader
 * checks. Framework-free: rendered by app/alternatives, read by sitemap/llms.
 */

export const CHECKED = "September 2026";

export interface Row {
  label: string;
  wigolo: string;
  them: string;
}

export interface QA {
  q: string;
  a: string;
}

export interface Alternative {
  slug: string;
  name: string;
  site: string;
  /** <title>: what people type — "<name> alternative", "free", "open source". */
  title: string;
  description: string;
  h1: string;
  lede: string;
  /** Their product, described the way they describe it. */
  about: string;
  rows: Row[];
  /** Their endpoint → the wigolo tool that covers it. */
  mapping: { theirs: string; wigolo: string; note?: string }[];
  faq: QA[];
  sources: { label: string; url: string }[];
}

/** Rows every comparison shares; `them` overrides a label's cell for one vendor. */
const sharedRows = (them: Record<string, string> = {}): Row[] =>
  [
    { label: "Where it runs", wigolo: "Your machine, or your own server", them: "Their cloud" },
    { label: "Account / API key", wigolo: "None", them: "Required" },
    { label: "Cost per query", wigolo: "$0, unlimited", them: "Metered (see pricing below)" },
    {
      label: "Where your queries go",
      wigolo: "Straight to the search engines it queries and the pages it fetches — no vendor in between, no account attached",
      them: "To the vendor, tied to your account",
    },
    {
      label: "Persistent local memory",
      wigolo: "Every page lands in a local cache with keyword + semantic re-query, offline",
      them: "—",
    },
    {
      label: "Evidence format",
      wigolo: "Verbatim excerpts pinned to byte-offset source spans, with an explainable score per result",
      them: "Results with snippets or page content",
    },
    {
      label: "Agent surfaces",
      wigolo:
        "MCP (stdio + HTTP), REST, CLI, TypeScript & Python SDKs, LangChain, CrewAI, LlamaIndex, Vercel AI SDK",
      them: "Hosted API, SDKs, MCP server",
    },
  ].map((r) => (them[r.label] ? { ...r, them: them[r.label] } : r));

const SHARED_FAQ: QA[] = [
  {
    q: "Does wigolo need an API key?",
    a: "No. Search, fetch, crawl, extract and the cache run keyless on your machine. An LLM key (or a local model) is optional and only adds answer synthesis to research and agent runs.",
  },
  {
    q: "Which agents does it work with?",
    a: "Any MCP client. `npx wigolo init --agents=<agent>` wires Claude Code, Cursor, Codex, Gemini CLI, OpenCode, VS Code, Windsurf, Zed and Antigravity in one command; frameworks and self-hosted automations use the REST API or the SDKs.",
  },
  {
    q: "Is it really free?",
    a: "Yes — wigolo is open source (AGPL-3.0) with no paid tier and no metered bill. It runs on hardware you already have, so there is nothing to charge per query. Companies that want to embed it without AGPL obligations can take a commercial license.",
  },
];

export const ALTERNATIVES: readonly Alternative[] = [
  {
    slug: "firecrawl",
    name: "Firecrawl",
    site: "https://www.firecrawl.dev",
    title: "Free Firecrawl alternative: open source, runs locally",
    description:
      "wigolo covers Firecrawl's scrape, crawl, map, search and extract as a free, keyless server on your own machine — over MCP, REST, CLI or SDK. No credits, no account.",
    h1: "A free, local alternative to Firecrawl",
    lede: "Scrape, crawl, map, search and extract — the same jobs, run on your machine with no credits, no account and no API key.",
    about:
      "Firecrawl is a web data API for scraping, crawling, mapping, searching and interacting with pages, sold as a hosted service on monthly credits. Its core is open source (AGPL-3.0) and can be self-hosted with Docker Compose.",
    rows: [
      ...sharedRows({
        "Where it runs": "Their cloud, or self-hosted with Docker Compose",
        "Account / API key": "Required for the hosted API",
        "Cost per query": "Metered on the hosted API (see pricing below)",
        "Where your queries go": "To the vendor on the hosted API, tied to your account",
      }),
      {
        label: "Pricing",
        wigolo: "Free",
        them: "Free plan: 1,000 credits a month. Hobby from $16/month billed yearly. 1 credit per scraped page; search is 2 credits per 10 results",
      },
      { label: "Licence", wigolo: "AGPL-3.0", them: "AGPL-3.0 (self-hosted core)" },
      { label: "Web search", wigolo: "18 engines fused, reranked on-device", them: "Search endpoint" },
      { label: "Scrape / crawl / map", wigolo: "fetch, crawl (bfs, dfs, sitemap, map)", them: "scrape, crawl, map" },
      { label: "JS-heavy pages", wigolo: "HTTP first, escalating to a headless browser engine when a page needs it", them: "Browser rendering" },
    ],
    mapping: [
      { theirs: "scrape", wigolo: "fetch", note: "clean markdown; `section` to pull one part of a page" },
      { theirs: "crawl", wigolo: "crawl", note: "bfs / dfs / sitemap strategies, robots.txt respected" },
      { theirs: "map", wigolo: "crawl", note: "`strategy: \"map\"` returns URLs only" },
      { theirs: "search", wigolo: "search", note: "multi-query, per-result evidence scores" },
      { theirs: "extract / JSON format", wigolo: "extract", note: "`schema`, `tables`, `metadata`, `selector` modes" },
      { theirs: "interact", wigolo: "fetch", note: "`actions` for click, type and scroll steps" },
      { theirs: "agent", wigolo: "agent / research" },
      { theirs: "monitor", wigolo: "watch", note: "interval checks, diffs, webhook delivery" },
    ],
    faq: [
      {
        q: "Is wigolo a drop-in Firecrawl replacement?",
        a: "The jobs map one to one — scrape → fetch, crawl → crawl, map → crawl with the map strategy, search → search, extract → extract, monitor → watch — but the API shape is wigolo's own. Point your agent at wigolo over MCP and it discovers the tools itself.",
      },
      {
        q: "Firecrawl is open source too — what's the difference?",
        a: "Self-hosting Firecrawl means running its service stack with Docker Compose, including its queue and database services. wigolo is a single local server you start with `npx wigolo init`: it adds a persistent local knowledge cache, multi-engine search fused and reranked on-device, and byte-offset source spans on every excerpt.",
      },
      ...SHARED_FAQ,
    ],
    sources: [
      { label: "Firecrawl pricing", url: "https://www.firecrawl.dev/pricing" },
      { label: "Firecrawl self-hosting guide", url: "https://docs.firecrawl.dev/contributing/self-host" },
    ],
  },
  {
    slug: "exa",
    name: "Exa",
    site: "https://exa.ai",
    title: "Free Exa alternative: AI web search, no API key",
    description:
      "wigolo gives agents web search, page contents, research and monitoring from your own machine: 18 engines fused and reranked on-device, $0 per query, no API key.",
    h1: "A free, local alternative to Exa",
    lede: "Web search, page contents and research for agents — fused from 18 engines and reranked on your machine, with no per-request bill.",
    about:
      "Exa is a hosted AI search API built on its own web index, with endpoints for search, page contents, deep search, answers, monitors and an agent, billed per request.",
    rows: [
      ...sharedRows(),
      {
        label: "Pricing",
        wigolo: "Free",
        them: "$10 in free credits a month. Search $7 per 1,000 requests, contents $1 per 1,000 pages, deep search $12–15 per 1,000",
      },
      {
        label: "Search index",
        wigolo: "Live results from 18 engines, fused with rank fusion and reranked by an on-device ML model",
        them: "Exa's own web index",
      },
      { label: "Page contents", wigolo: "fetch, with full markdown or evidence excerpts", them: "Contents endpoint" },
      { label: "Research", wigolo: "research: decomposes a question, searches in parallel, returns a cited brief", them: "Deep search / agent" },
    ],
    mapping: [
      { theirs: "search", wigolo: "search", note: "`category`, `include_domains`, date filters, `search_depth`" },
      { theirs: "contents", wigolo: "fetch", note: "or `include_full_markdown` on search results" },
      { theirs: "answer", wigolo: "search", note: "`format: \"answer\"` for a synthesized answer" },
      { theirs: "deep search / agent", wigolo: "research / agent" },
      { theirs: "monitors", wigolo: "watch" },
      { theirs: "similar pages", wigolo: "find_similar", note: "across everything in your local cache" },
    ],
    faq: [
      {
        q: "Does wigolo have its own search index like Exa?",
        a: "wigolo searches the live web through 18 engines at once, fuses the results and reranks them on-device, then keeps every page it reads in a local semantic cache — so the pages that matter to you become instantly re-searchable, offline, over time.",
      },
      {
        q: "Can it return page content with search results?",
        a: "Yes. Search results carry verbatim excerpts with source spans by default; set `include_full_markdown` for full page bodies, or call fetch on any URL.",
      },
      ...SHARED_FAQ,
    ],
    sources: [{ label: "Exa pricing", url: "https://exa.ai/pricing" }],
  },
  {
    slug: "tavily",
    name: "Tavily",
    site: "https://www.tavily.com",
    title: "Free Tavily alternative: local search API for agents",
    description:
      "wigolo covers Tavily's search, extract, crawl, map and research as a free local server for AI agents: no API key, no credits, over MCP, REST, CLI or SDK.",
    h1: "A free, local alternative to Tavily",
    lede: "Search, extract, crawl, map and research for your agents — on your own machine, with no credits to count.",
    about:
      "Tavily is a hosted search API for AI agents and RAG, with search, extract, crawl, map and research endpoints billed in credits.",
    rows: [
      ...sharedRows(),
      {
        label: "Pricing",
        wigolo: "Free",
        them: "1,000 free credits a month; plans from $30 for 4,000 credits; pay-as-you-go $0.008 per credit. Basic search is 1 credit, advanced 2",
      },
      { label: "Web search", wigolo: "18 engines fused, reranked on-device, explainable scores", them: "Search endpoint (basic / advanced depth)" },
      { label: "Extract / crawl / map", wigolo: "fetch, extract, crawl (bfs, dfs, sitemap, map)", them: "extract, crawl, map" },
      { label: "Research", wigolo: "research: cited brief, LLM optional", them: "Research endpoint" },
    ],
    mapping: [
      { theirs: "search", wigolo: "search", note: "`search_depth` from `ultra-fast` (cache only) to `deep`" },
      { theirs: "extract", wigolo: "fetch / extract" },
      { theirs: "crawl", wigolo: "crawl" },
      { theirs: "map", wigolo: "crawl", note: "`strategy: \"map\"`" },
      { theirs: "research", wigolo: "research" },
    ],
    faq: [
      {
        q: "Can I swap Tavily out of a LangChain or CrewAI agent?",
        a: "Yes. wigolo ships LangChain, CrewAI and LlamaIndex integrations and a Vercel AI SDK tool set, plus TypeScript and Python clients, so the web tools in your agent point at your own machine instead of a metered API.",
      },
      {
        q: "How fast is it without a hosted index?",
        a: "`search_depth` trades depth for speed: `ultra-fast` answers from the local cache, `fast` queries engines only, `balanced` (the default) adds enrichment, `deep` goes furthest. Repeat questions get cheaper as the cache warms.",
      },
      ...SHARED_FAQ,
    ],
    sources: [{ label: "Tavily credits & pricing", url: "https://docs.tavily.com/documentation/api-credits" }],
  },
];

export const getAlternative = (slug: string): Alternative | undefined =>
  ALTERNATIVES.find((a) => a.slug === slug);
