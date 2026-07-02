#!/usr/bin/env bash
# Regenerate the wigolo 4-WAY parity demo (GIF + MP4 + WebM + poster).
#
#   cd .demo && ./build-compare4.sh
#
# Records a real Claude Code session that calls four web tools live —
# WebSearch + wigolo + Tavily + Firecrawl (Exa deliberately excluded) — on one
# query, then tabulates an honest side-by-side. Requires firecrawl at USER scope
# (~/.claude.json mcpServers). Crops header + table + input, drops the two top
# banners. Ends with a 5s frozen hold so the full answer is readable before loop.
# Offsets tuned to compare4.tape geometry (Height 1520, FontSize 18) and the
# answer's line count — re-measure if either changes.
set -euo pipefail
cd "$(dirname "$0")"
ASSETS="../assets"

vhs compare4.tape   # -> raw.mp4

CROP='[0:v]crop=1280:95:0:58[a];[0:v]crop=1280:672:0:230[b];[0:v]crop=1280:100:0:1420[c];[a][b][c]vstack=inputs=3,pad=1280:907:0:20:0x0f0f0f[v]'
ffmpeg -y -v error -i raw.mp4 -filter_complex "$CROP" -map '[v]' -an c4crop.mp4

# Trim to just past answer completion (~t=38s); the 5s hold is added below.
ffmpeg -y -v error -i c4crop.mp4 -t 42 c4trim.mp4

HOLD="tpad=stop_mode=clone:stop_duration=5"
ffmpeg -y -v error -i c4trim.mp4 -vf "scale=1200:-2:flags=lanczos,$HOLD,format=yuv420p" \
  -c:v libx264 -crf 22 -movflags +faststart -an "$ASSETS/wigolo-vs.mp4"
ffmpeg -y -v error -i c4trim.mp4 -vf "scale=1200:-2:flags=lanczos,$HOLD" \
  -c:v libvpx-vp9 -crf 34 -b:v 0 -an "$ASSETS/wigolo-vs.webm"
ffmpeg -y -v error -i c4trim.mp4 -filter_complex \
  "[0:v]setpts=PTS/3.0,fps=10,scale=940:-2:flags=lanczos,$HOLD,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  "$ASSETS/wigolo-vs.gif"
ffmpeg -y -v error -sseof -1 -i "$ASSETS/wigolo-vs.mp4" -vframes 1 "$ASSETS/wigolo-vs-poster.png"

rm -f raw.mp4 c4crop.mp4 c4trim.mp4
echo "done -> $ASSETS/wigolo-vs.{gif,mp4,webm} + poster"
