# answer synthesis through Fluxion AI

> **Sponsored example.** [Fluxion AI](https://wigolo.app/go/fluxion/?ref=docs) sponsors wigolo. Search, fetch, crawl and extract never need a model; this only adds synthesis on top. Any OpenAI-compatible provider works the same way — see [Swapping providers](#swapping-providers).

wigolo's core tools run keyless. An LLM adds three things on top: `format: "answer"` on `search`, essay-grade briefs from `research`, and a structured-extraction fallback. This wires those up through Fluxion AI's OpenAI-compatible API.

## Set it up

1. Create a key at [Fluxion AI](https://wigolo.app/go/fluxion/?ref=docs).
2. Point wigolo's `openai` provider at Fluxion:

```bash
export WIGOLO_LLM_PROVIDER=openai
export OPENAI_BASE_URL=https://fluxionai.world/v1
export OPENAI_API_KEY=sk-...            # your Fluxion AI key
export WIGOLO_LLM_MODEL=claude-haiku-4-5
```

`claude-haiku-4-5` is fast and inexpensive for synthesis; any model from Fluxion's model list works.

For an agent wired over MCP, put the same variables in the server's `env` block, for example in Claude Code:

```bash
claude mcp add wigolo --scope user \
  -e WIGOLO_LLM_PROVIDER=openai \
  -e OPENAI_BASE_URL=https://fluxionai.world/v1 \
  -e OPENAI_API_KEY=sk-... \
  -e WIGOLO_LLM_MODEL=claude-haiku-4-5 \
  -- npx -y wigolo
```

## Try it

```bash
npx wigolo search "what changed in the latest node.js release" --format=answer
npx wigolo research "compare sqlite fts5 and tantivy for local search"
```

`search` returns a cited answer instead of evidence only, and `research` returns a written brief. Without a model configured, both still work and return the structured evidence for your agent to write from.

## Swapping providers

The same three variables point wigolo at any OpenAI-compatible service that takes an API key: change `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `WIGOLO_LLM_MODEL`. Anthropic, OpenAI, Gemini and Groq also have first-class providers, and a local model server needs no key at all — see [configuration](../../docs/configuration.md#llm-providers-optional).
