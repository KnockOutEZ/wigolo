# wigolo-ai-sdk

Vercel AI SDK tools for [wigolo](https://github.com/KnockOutEZ/wigolo) — a local-first web search MCP server for AI coding agents.

## Installation

```bash
npm install wigolo-ai-sdk ai zod
```

Requires wigolo to be available via npx:
```bash
npm install -g @staticn0va/wigolo
```

## Quick Start

### All Tools at Once

```typescript
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { WigoloMcpClient, createWigoloTools } from 'wigolo-ai-sdk';

const client = new WigoloMcpClient();
await client.connect();

const tools = createWigoloTools(client);

const { text } = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'Search for the latest React Server Components documentation and summarize it',
});

await client.disconnect();
```

### Individual Tools

```typescript
import { WigoloMcpClient, createWebSearchTool, createWebFetchTool } from 'wigolo-ai-sdk';

const client = new WigoloMcpClient();
await client.connect();

const tools = {
  search: createWebSearchTool(client),
  fetch: createWebFetchTool(client),
};
```

### Custom Server Command

```typescript
const client = new WigoloMcpClient({
  command: 'node',
  args: ['./dist/index.js'],
  timeoutMs: 60000,
});
```

## Available Tools

| Tool | Function | Description |
|------|----------|-------------|
| `webSearch` | `createWebSearchTool` | Search the web with domain filtering, categories, and date ranges |
| `webFetch` | `createWebFetchTool` | Fetch a URL and get clean markdown with section extraction |
| `webCrawl` | `createWebCrawlTool` | Crawl a site with BFS, DFS, sitemap, or map strategies |
| `findSimilar` | `createFindSimilarTool` | Find semantically similar pages from local cache |
| `research` | `createResearchTool` | Deep multi-step research with automatic query planning |
| `agent` | `createAgentTool` | Autonomous web agent for complex multi-hop tasks |

## API Reference

### WigoloMcpClient

```typescript
const client = new WigoloMcpClient({
  command: 'npx',           // default
  args: ['@staticn0va/wigolo'], // default
  timeoutMs: 30000,         // default
});

await client.connect();
const result = await client.callTool('search', { query: 'test' });
await client.disconnect();
```

### createWigoloTools(client)

Returns an object with all 6 tools, ready for use with Vercel AI SDK's `generateText` or `streamText`.

### Individual create*Tool(client) functions

Each returns a single Vercel AI SDK tool definition with typed parameters (via zod) and an async execute function.

## License

MIT
