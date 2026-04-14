# MCP Registry Submissions

Maintainer reference for submitting wigolo to MCP server registries.

## Smithery (smithery.ai)

1. Go to https://smithery.ai/submit
2. Provide the GitHub repository URL: `https://github.com/KnockOutEZ/wigolo`
3. Fields:
   - **Name:** wigolo
   - **Description:** Local-first web search MCP server for AI coding agents. Search, fetch, crawl, cache, and extract from the web with zero API keys.
   - **Category:** Search & Web
   - **Tags:** mcp, search, web-scraping, local-first, ai-agent
   - **Install command:** `npx @staticn0va/wigolo`
   - **Transport:** stdio
   - **Tools:** search, fetch, crawl, cache, extract
4. Smithery auto-reads `package.json` and may auto-populate fields from the `mcp` config.

## PulseMCP (pulsemcp.com)

1. Go to https://pulsemcp.com/submit
2. Fields:
   - **Server Name:** wigolo
   - **npm Package:** @staticn0va/wigolo
   - **GitHub URL:** https://github.com/KnockOutEZ/wigolo
   - **Description:** Local-first web search MCP server. 5 tools: search, fetch, crawl, cache, extract. Zero API keys, zero cloud.
   - **Category:** Web & Search
   - **Pricing:** Free / Open Source
   - **License:** BSL 1.1
3. PulseMCP crawls the README for tool descriptions.

## mcpservers.org

1. Submit a PR to the mcpservers.org repository (or use their submission form).
2. Entry format (YAML):
   ```yaml
   name: wigolo
   description: Local-first web search MCP server for AI coding agents
   url: https://github.com/KnockOutEZ/wigolo
   npm: "@staticn0va/wigolo"
   transport: stdio
   category: search
   tools:
     - search
     - fetch
     - crawl
     - cache
     - extract
   license: BUSL-1.1
   ```

## glama.ai MCP Directory

1. Go to https://glama.ai/mcp/servers and submit via their form.
2. GitHub URL: `https://github.com/KnockOutEZ/wigolo`
3. They auto-detect MCP servers from the repository.

## npm Discovery

The `mcp` field in `package.json` and the `mcp-server` keyword enable discovery via:
- `npx mcp search web-search` (emerging pattern)
- npm keyword search: https://www.npmjs.com/search?q=keywords:mcp-server

## Skills Protocol (Emerging)

If/when `npx skills add <package>` becomes standard:
- The `SKILL.md` file at repo root is already in the expected format.
- The `mcp` field in `package.json` provides the machine-readable config.
- No additional action needed -- the protocol reads these files directly.

## Verification Checklist

After submitting to each registry:

- [ ] Listing appears on registry with correct tool count (5)
- [ ] Install command works: `npx @staticn0va/wigolo`
- [ ] Description matches the one in SKILL.md
- [ ] Category is "Search" or "Web & Search"
- [ ] Link back to GitHub is correct
- [ ] License displays as BSL 1.1
