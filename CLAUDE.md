# Wigolo - Development Standards

## What This Is

Local-first MCP server providing 8 tools (search, fetch, crawl, cache, extract, find_similar, research, agent) for AI coding agents. Zero API keys, zero cloud. TypeScript on Node.js, Playwright for JS-rendered pages, SearXNG for search, SQLite FTS5 for caching, sentence-transformers for embeddings.

## Architecture

```
src/
├── index.ts          # Entry point — CLI routing (mcp/warmup/serve/health/doctor/auth/plugin/shell/init)
├── server.ts         # MCP server setup, tool registration, lifecycle
├── config.ts         # Environment-based configuration (52+ env vars)
├── logger.ts         # Structured logging to stderr (JSON/text)
├── types.ts          # All shared TypeScript types
├── instructions.ts   # Dynamic MCP instructions based on backend state
├── cli/              # CLI commands (warmup, daemon, health, doctor, auth, plugin, shell, init)
├── tools/            # Thin MCP tool handlers (one per tool)
├── fetch/            # HTTP client, Playwright browser pool, smart router, auth, CDP, actions, Lightpanda
├── extraction/       # Ensemble pipeline (Defuddle + Trafilatura + Readability), site extractors, schema
├── search/           # SearXNG client, direct engines, dedup, reranking, RRF, multi-query, answer synthesis
├── crawl/            # BFS/DFS/sitemap/map crawler, robots.txt, rate limiting
├── cache/            # SQLite FTS5 store, change detection, DB lifecycle
├── embedding/        # sentence-transformers subprocess, VectorIndex, key-terms
├── research/         # Question decomposition → parallel search → synthesis
├── agent/            # Plan → execute → synthesize autonomous pipeline
├── searxng/          # SearXNG process management (native + Docker), bootstrap, retry
├── daemon/           # HTTP server, health checks, proxy client
├── plugins/          # Loader, registry, validation
└── repl/             # Interactive shell commands and formatters
```

## Language
- **TypeScript** is the primary language

## Release
- Use Makefile commands and follow the release process.

## Commands

```bash
npm test              # full test suite (vitest)
npm run test:unit     # unit tests only
npm run test:e2e      # end-to-end tests
npm run build         # tsc -> dist/
npm run dev           # tsx src/index.ts
npm run lint          # tsc --noEmit
```

## Development Workflow
- Use superpowers skills for all feature work (brainstorm -> plan -> TDD -> implement -> review -> verify)
- Break work into small, incremental chunks
- Research with Tavily MCP tools when external knowledge is needed

## Testing
- Write tests for every feature and change
- Unit tests for individual functions/methods
- Integration tests for component interactions
- E2E tests that simulate real-world scenarios
- Tests run before any code is considered complete

## Code Style
- Minimal comments — only where logic is non-obvious
- Clean, idiomatic TypeScript
- No excessive documentation on unchanged code

## Git
- No `Co-Authored-By` lines in commits
- Always use `--no-gpg-sign` (`-c commit.gpgsign=false`)
- Concise, meaningful commit messages following conventional format:
  - `feat: add multi-query array support to search tool`
  - `fix: research token budget enforcement`
  - `test: add find_similar hybrid search tests`
  - `refactor: extract RRF into shared utility`
  - `chore: add TUI dependencies`
  - `docs: update API reference for force_refresh`
- One commit per task/step, not per file, not per slice

## Key Patterns
- **Thin tool handlers**: `src/tools/*.ts` validate input and delegate to domain modules
- **Smart routing**: HTTP-first, Playwright fallback when JS rendering detected
- **Ensemble extraction**: Defuddle first, Trafilatura fallback, Readability.js fallback, site-specific extractors for GitHub/SO/MDN/docs
- **All logging to stderr**: stdout is reserved for MCP protocol (stdio transport)
- **Python packages go to SearXNG venv**: ALL Python packages (Trafilatura, FlashRank, sentence-transformers) install to `~/.wigolo/searxng/venv/`. Use the venv Python for all subprocess calls:
  ```typescript
  const venvPython = join(getConfig().dataDir, 'searxng', 'venv', 'bin', 'python');
  ```

## Don'ts
- Never write to stdout in MCP server mode — it breaks the protocol
- Never put business logic in `src/tools/*.ts` — they're thin wrappers only
- Never use `console.log` — use `createLogger()` from `logger.ts`
- Never add dependencies without documenting them in README.md
- Never commit CLAUDE.md
- Never commit docs/
- Never commit Makefile
- Never install Python packages to system Python — always use the SearXNG venv
- Never use `as any` casts — fix the types
- Never skip or `.skip` tests — fix the code instead
- Never expose implementation dependencies in user-facing text — describe capabilities instead:
  - "ML reranker" not "FlashRank"
  - "search engine" not "SearXNG"
  - "content extractor" not "Trafilatura"
  - "browser engine" not "Playwright"
  - Exception: warmup/doctor output shows component names in parentheses for troubleshooting (e.g. "ML reranker (flashrank)")

## Behavioral Guardrails (Anti-Laziness)

- **No Shortcuts**: Never use placeholders like `// ... rest of code` or `# existing logic stays here`. Always output the full, functional code block for the file being edited.
- **Deep Reasoning First**: Before every action, perform a "Chain of Thought" analysis. Identify edge cases, potential breaking changes in `src/`, and type safety risks before writing a single line of code.
- **Verify, Don't Assume**: After running a tool or editing a file, you must verify the result (e.g., `ls`, `grep`, or running a test). Do not tell the user a task is "done" based on intent; only based on verified state.
- **Strict TDD**: You are prohibited from declaring a feature "implemented" until a corresponding test in `tests/` passes. If a test fails, your primary objective is to fix the code, not "skip" the test.
- **Context Refresh**: If you detect that the conversation is becoming circular or you are repeating mistakes, explicitly suggest that the user starts a fresh session or clears the current context.
- **Direct Execution**: When a task requires multiple steps (e.g., Build -> Test -> Lint), execute them sequentially without waiting for individual user prompts for each sub-step.
- **No Narrated Tool Use**: Do not explain what you are about to do in great detail. Spend that "token budget" on the actual implementation and verification.

---

## COMPACTION RESILIENCE PROTOCOL

Long sessions WILL get compacted. Follow this protocol to never lose work.

### Progress Tracking (mandatory for any multi-step work)

Before starting any multi-step task (implementing slices, fixing multiple issues, writing multiple plans):

1. **Create a progress tracker** at the path specified by the task, or at `docs/superpowers/plans/CURRENT_PROGRESS.md` if none specified:

```markdown
# [Task Name] Progress

## Status
- Current: [what you're working on]
- Completed: [count]/[total]
- Last updated: [timestamp]

## Done
| # | Item | Status | Notes |
|---|------|--------|-------|

## In Progress
- Item: [name]
- Current step: [step]
- Files modified: [list]
- Last test run: [pass/fail]
- Last commit: [message]

## Remaining
- [ ] ...
```

2. **Update the tracker after every meaningful checkpoint**: after each commit, after each test run, after each slice completion.

3. **NEVER rely on memory across compaction.** The tracker IS your memory.

### After Every Compaction

When context gets compressed, your FIRST actions are:

1. Read the progress tracker file
2. Read the task spec/description header only
3. Determine: what was in progress? Done or partial?
4. If partial: read that item's plan, find last completed step, continue
5. If done: move to next item

**DO NOT:**
- Start over from the beginning
- Re-read completed items
- Re-implement completed features
- Assume you know what was done — CHECK THE TRACKER
- Write code without first confirming current state

### State File (mid-step recovery)

For complex tasks, also maintain `docs/superpowers/plans/CURRENT_STATE.md`:

```markdown
# Current State
## Working on: [item/slice]
## Task: [number and name]
## Step: [number]
## Last test run: [count] passing, [count] failing
## Last commit: [message]
## Files touched: [list]
## Known issues: [any]
```

---

## WHEN A TASK IS COMPLETE: Auto-Cleanup & Release

When ALL items in a task are done (all slices implemented, all tests passing, all reviews clean), execute this sequence automatically without asking:

### 1. Final verification
```bash
npm test
npx tsc --noEmit
grep -rn "console\.log" src/ | grep -v node_modules
grep -rn "as any" src/ | wc -l
```
Fix anything broken before proceeding.

### 2. Update codebase docs
Update relevant files in `docs/superpowers/codebase/`:
- `FEATURES.md` — new/changed features
- `API_REFERENCE.md` — new/changed parameters
- `CONFIGURATION.md` — new config options
- `PRODUCT.md` — update stats, known limitations
- `INVENTORY.md` — update counts if significantly changed

Targeted updates only — don't rewrite from scratch.

### 3. Clean local machine
```bash
# Remove wigolo from Claude Code MCP
claude mcp remove wigolo 2>/dev/null || true

# Remove ALL wigolo data
rm -rf ~/.wigolo

# Remove Python packages from system Python (safety net)
python3 -m pip uninstall -y flashrank trafilatura sentence-transformers 2>/dev/null || true
```

### 4. Build and release
- Follow makefile

### 5. Report
```markdown
## Release Complete
- Version: [version]
- Tests: [count] passing
- Changes: [summary]

### Fresh install test (run manually on clean machine):
npx @staticn0va/wigolo warmup --all
npx @staticn0va/wigolo doctor
claude mcp add wigolo -- npx @staticn0va/wigolo
```

### 6. Clean up tracking files
```bash
rm -f docs/superpowers/plans/CURRENT_STATE.md
```