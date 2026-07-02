#!/usr/bin/env bash
# Regenerate the wigolo demo assets (GIF + MP4 + WebM + poster).
#
#   cd .demo && ./build.sh
#
# Records a real Claude Code session (wigolo-only MCP) via VHS, then crops out
# Claude's release banner (top) and input box (bottom) and encodes each format.
# The crop offsets below are tuned to the tape's geometry (Height 960,
# FontSize 20, Padding 28) — re-measure if you change those.
set -euo pipefail
cd "$(dirname "$0")"
ASSETS="../assets"

vhs wigolo.tape   # -> raw.mp4

# 3-part vstack: [header] + [conversation] + [input box], skipping the launch
# command line (top) and the "Meet Sonnet 5" release banner (mid). Keeps the
# Claude Code header and the input box; adds a 20px dark margin top/bottom.
CROP='[0:v]crop=1200:95:0:144[a];[0:v]crop=1200:392:0:330[b];[0:v]crop=1200:108:0:742[c];[a][b][c]vstack=inputs=3,pad=1200:635:0:20:0x0f0f0f[v]'
ffmpeg -y -v error -i raw.mp4 -filter_complex "$CROP" -map '[v]' -an crop.mp4

# Trim trailing idle (answer lands ~t=25s); keep a short hold.
ffmpeg -y -v error -i crop.mp4 -t 29 trim.mp4

ffmpeg -y -v error -i trim.mp4 -vf "scale=1200:-2:flags=lanczos,format=yuv420p" \
  -c:v libx264 -crf 22 -movflags +faststart -an "$ASSETS/wigolo-demo.mp4"
ffmpeg -y -v error -i trim.mp4 -vf "scale=1200:-2:flags=lanczos" \
  -c:v libvpx-vp9 -crf 34 -b:v 0 -an "$ASSETS/wigolo-demo.webm"
ffmpeg -y -v error -i trim.mp4 -filter_complex \
  "[0:v]setpts=PTS/1.9,fps=13,scale=1000:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  "$ASSETS/wigolo-demo.gif"
ffmpeg -y -v error -sseof -0.5 -i "$ASSETS/wigolo-demo.mp4" -vframes 1 "$ASSETS/wigolo-demo-poster.png"

rm -f raw.mp4 crop.mp4 trim.mp4
echo "done -> $ASSETS/wigolo-demo.{gif,mp4,webm} + poster"
