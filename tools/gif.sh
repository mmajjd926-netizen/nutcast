#!/bin/sh
# Turns the recorded demo (tools/demo-video.mjs) into shots/demo.gif for the README.
set -e
f=$(ls shots/video/*.webm | head -1)
ffmpeg -v error -y -i "$f" -vf "fps=7,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" shots/demo.gif
ls -la shots/demo.gif
