# one-shot CLI: search, fetch, and the --json | jq contract.
# Renders demo.gif. Run from this directory: `vhs demo.tape`
#
# The renderer exports WIGOLO_TAPE_DIST (absolute path to <repo>/dist/index.js)
# so the recording runs the repo's local build; a user types `npx wigolo ...`
# or `wigolo ...` instead (see README). Uses your real local cache, so repeat
# queries answer in milliseconds. (`run.sh` additionally covers `research`,
# whose ~15s quick-depth run does not fit this clip.)

Output demo.gif

Set Shell "bash"
Set FontSize 13
Set Width 1000
Set Height 620
Set Padding 12
Set Theme "Catppuccin Mocha"
Set Framerate 20
Set TypingSpeed 20ms

Hide
Type `export LOG_LEVEL=warn`
Enter
Type `alias wigolo="node $WIGOLO_TAPE_DIST"`
Enter
Type "clear"
Enter
Show

Type `wigolo search "css grid layout guide" --limit 5 2>/dev/null`
Sleep 400ms
Enter
Sleep 5s

Type `wigolo fetch https://developer.mozilla.org/en-US/docs/Web/API/structuredClone 2>/dev/null`
Sleep 400ms
Enter
Sleep 4s

Type `wigolo search "node worker threads" --limit 3 --json 2>/dev/null | jq '.results[0] | {title, url, relevance_score}'`
Sleep 400ms
Enter
Sleep 6s

Sleep 2s
