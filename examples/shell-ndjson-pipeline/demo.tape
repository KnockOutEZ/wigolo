# shell + NDJSON: pipe commands in, get one JSON doc per line out, gate on
# the exit code. Renders demo.gif. Run from this directory: `vhs demo.tape`
#
# The renderer exports WIGOLO_TAPE_DIST (absolute path to <repo>/dist/index.js)
# so the recording runs the repo's local build; a user types `npx wigolo ...`
# or `wigolo ...` instead (see README).

Output demo.gif

Set Shell "bash"
Set FontSize 13
Set Width 1000
Set Height 380
Set Padding 12
Set Theme "Catppuccin Mocha"
Set Framerate 20
Set TypingSpeed 20ms

Hide
Type `export LOG_LEVEL=warn; set -o pipefail`
Enter
Type `alias wigolo="node $WIGOLO_TAPE_DIST"`
Enter
Type "clear"
Enter
Show

Type `printf 'search "web components shadow dom" --limit 3 --no-content\ncache stats\n' | wigolo shell --json 2>/dev/null | jq -c 'if .results then {results: (.results | length), top: .results[0].url} else .stats end'`
Sleep 400ms
Enter
Sleep 4.5s

Type `printf 'fetch https://no-such-host.invalid\n' | wigolo shell --json 2>/dev/null | jq -c '{url, error}'; echo "exit=$?"`
Sleep 400ms
Enter
Sleep 3.5s

Sleep 2s
