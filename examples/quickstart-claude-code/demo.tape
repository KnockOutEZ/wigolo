# quickstart: `wigolo init --agents=claude-code`
# Renders demo.gif. Run from this directory: `vhs demo.tape`
#
# The recording runs the repo's local build inside a throwaway HOME with
# pre-warmed model caches (see README "About the GIF"). The renderer exports:
#   WIGOLO_TAPE_DIST      absolute path to <repo>/dist/index.js
#   WIGOLO_TAPE_BROWSERS  a browser-engine cache dir that already has the browsers
#   WIGOLO_TAPE_PATH      a PATH for the demo shell (node + system utils)
# and pre-seeds /private/tmp/quickstart/.wigolo with warmed model caches.

Output demo.gif

Set Shell "bash"
Set FontSize 13
Set Width 1000
Set Height 620
Set Padding 12
Set Theme "Catppuccin Mocha"
Set Framerate 20
Set TypingSpeed 35ms

Hide
Type `export HOME=/private/tmp/quickstart LOG_LEVEL=warn PLAYWRIGHT_BROWSERS_PATH="$WIGOLO_TAPE_BROWSERS" PATH="$WIGOLO_TAPE_PATH"`
Enter
Type `alias wigolo="node $WIGOLO_TAPE_DIST"`
Enter
Type "clear"
Enter
Show

Type "wigolo init --agents=claude-code --skip-verify"
Sleep 400ms
Enter

# init finishes in ~6s with warmed caches; linger on the final report.
Sleep 10s
Sleep 2s
