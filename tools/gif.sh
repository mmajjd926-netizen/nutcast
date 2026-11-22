#!/bin/sh
# Turns a recorded demo into a GIF for the README.
#   tools/gif.sh                                     shots/video/*.webm  -> shots/demo.gif (tools/demo-video.mjs)
#   tools/gif.sh shots/video-nz shots/nutzap-stream.gif                  (tools/demo-nutzap-video.mjs)
set -e
dir=${1:-shots/video}
out=${2:-shots/demo.gif}
f=$(ls -t "$dir"/*.webm | head -1)
ffmpeg -v error -y -i "$f" -vf "fps=7,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$out"
ls -la "$out"
