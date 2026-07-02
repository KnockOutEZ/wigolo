# wigolo 4-way parity demo — Claude calls WebSearch + wigolo + Tavily + Firecrawl
# on one live query, then an honest side-by-side. Render: cd .demo && ./build-compare4.sh
# Requires firecrawl at USER scope (~/.claude.json mcpServers). Exa excluded on purpose.

Output raw.mp4

Require claude

Set Shell zsh
Set FontFamily "Menlo"
Set FontSize 18
Set Width 1280
Set Height 1520
Set Padding 28
Set Margin 20
Set MarginFill "#0f0f0f"
Set BorderRadius 12
Set TypingSpeed 42ms
Set Theme { "name": "wigolo", "background": "#1a1a1a", "foreground": "#f5f3ee", "cursor": "#f5f3ee", "selection": "#3a3730", "black": "#1a1a1a", "red": "#e06c75", "green": "#98c379", "yellow": "#e5c07b", "blue": "#61afef", "magenta": "#c678dd", "cyan": "#56b6c2", "white": "#f5f3ee", "brightBlack": "#5c5650", "brightRed": "#e06c75", "brightGreen": "#98c379", "brightYellow": "#e5c07b", "brightBlue": "#61afef", "brightMagenta": "#c678dd", "brightCyan": "#56b6c2", "brightWhite": "#ffffff" }

# --- Launch Claude Code with the full toolset (hidden setup) ---
Hide
Type "clear && cd .."
Enter
Type "claude --allowedTools WebSearch,mcp__wigolo__search,mcp__tavily__tavily_search,mcp__firecrawl__firecrawl_search --disallowedTools Bash,Read,Edit,Write,Glob,Grep,WebFetch,TodoWrite,Task,Skill,mcp__exa__web_search_exa"
Enter
Sleep 20s
Show

# --- The demo: one query, four tools, honest parity table (prompt pasted, not typed) ---
Sleep 1s
Type@1ms "normal mode. Actually call these FOUR web tools once each on the query 'postgres 18 async IO real-world benchmark': WebSearch, wigolo, Tavily, Firecrawl. Then a compact markdown table, one row per tool with TERSE cells: tool | #results | top source | nailed it? Use ONLY real domain names in the source column, never invent a name, and keep each 'nailed it?' cell to one short clause. Be fair and honest and note where wigolo matches the paid tools. No preamble."
Sleep 1s
Enter

# Agent fans out across the four tools, then tabulates. Long final hold so the
# whole answer is readable before the loop restarts.
Sleep 85s
Sleep 6s
