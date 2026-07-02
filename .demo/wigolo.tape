# wigolo demo — Claude Code answering a web question through wigolo (no API keys)
# Render: cd .demo && vhs wigolo.tape

Output raw.mp4

Require claude

Set Shell zsh
Set FontFamily "Menlo"
Set FontSize 20
Set Width 1200
Set Height 960
Set Padding 28
Set Margin 20
Set MarginFill "#0f0f0f"
Set BorderRadius 12
Set TypingSpeed 55ms
Set Theme { "name": "wigolo", "background": "#1a1a1a", "foreground": "#f5f3ee", "cursor": "#f5f3ee", "selection": "#3a3730", "black": "#1a1a1a", "red": "#e06c75", "green": "#98c379", "yellow": "#e5c07b", "blue": "#61afef", "magenta": "#c678dd", "cyan": "#56b6c2", "white": "#f5f3ee", "brightBlack": "#5c5650", "brightRed": "#e06c75", "brightGreen": "#98c379", "brightYellow": "#e5c07b", "brightBlue": "#61afef", "brightMagenta": "#c678dd", "brightCyan": "#56b6c2", "brightWhite": "#ffffff" }

# --- Launch Claude Code with ONLY wigolo wired in (hidden setup) ---
Hide
Type "clear && cd .."
Enter
Type "claude --setting-sources project,local --mcp-config .demo/mcp.json --strict-mcp-config --allowedTools mcp__wigolo__search,mcp__wigolo__fetch,mcp__wigolo__cache,mcp__wigolo__research --disallowedTools Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,TodoWrite,Task,Skill"
Enter
Sleep 12s
Show

# --- The demo: ask a live web question, watch wigolo answer ---
Sleep 1s
Type "Use wigolo to fetch the wigolo README, then explain its tiered fetch router (HTTP, TLS-impersonation, headless browser) in two lines. No preamble."
Sleep 1s
Enter

# Agent fetches the live README through wigolo, then answers
Sleep 44s
Sleep 2s
