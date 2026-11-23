#!/bin/sh
# Nutcast walkthrough video: intro card + two headless recordings with captions + outro card -> nutcast-walkthrough.mp4
# Inputs: the webm recordings from tools/demo-video.mjs and tools/demo-nutzap-video.mjs. Output: ../../public/walkthrough.mp4
set -e
cd "$(dirname "$0")"
R=$(cd ../.. && pwd)
A=$(ls $R/shots/video/*.webm | head -1)
B=$(ls -t $R/shots/video-nz/*.webm | head -1)
F=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
FB=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
W=1100; H=760; CH=96
mkdir -p t
cap() { printf '%s' "$2" > t/$1.txt; }
# captions for A (30.4 s)
cap a1 "Nutcast: a podcast player that pays the show's value split in Cashu ecash, from a wallet that lives in the page."
cap a2 "Top up over Lightning. This is the test mint, so the Lightning is fake and the sats are not real."
cap a3 "Boost 50 sat. The <podcast:value> split pays the Lightning-address share by melting ecash; the keysend share is skipped, not redistributed."
cap a4 "This episode's recipient takes ecash directly (a NUT-18 payment request): the boost goes out over Nostr with no Lightning fee."
cap a5 "The podcaster's side: 'Your inbox' opens the NIP-17 gift wraps and the ecash lands in their own wallet. +21 sat."
# captions for B (34.9 s)
cap b1 "Shows that name their npub in the feed get Nutzaps (NIP-61), locked to the key in the show's kind 10019."
cap b2 "A 21-sat boost goes out as a nutzap: ecash locked to the show's key, published to its relays. No Lightning on the way."
cap b3 "Stream while you listen: sats accrue every second and go out as 10-sat nutzaps, each tagged with the episode (NIP-73)."
cap b4 "Every payment is in the history. No node, no channel, no account: just ecash in a static web page."
dt() { echo "drawtext=fontfile=$F:textfile=t/$1.txt:fontcolor=white:fontsize=21:line_spacing=6:x=28:y=$H+18:enable='between(t,$2,$3)'"; }
wrap() { fold -s -w 92 t/$1.txt > t/$1.w && mv t/$1.w t/$1.txt; }
for c in a1 a2 a3 a4 a5 b1 b2 b3 b4; do wrap $c; done
base="scale=$W:$H,pad=$W:$H+$CH:0:0:color=0x3b2416,fps=25,format=yuv420p"
ffmpeg -v error -y -i "$A" -vf "$base,$(dt a1 0 2.6),$(dt a2 2.6 8.6),$(dt a3 8.6 15.2),$(dt a4 15.2 21.6),$(dt a5 21.6 31)" -an -c:v libx264 -crf 26 -preset slow t/A.mp4
ffmpeg -v error -y -i "$B" -vf "$base,$(dt b1 0 7.4),$(dt b2 7.4 13.6),$(dt b3 13.6 31.6),$(dt b4 31.6 36)" -an -c:v libx264 -crf 26 -preset slow t/B.mp4
# cards
card() { # name seconds title line1 line2
  printf '%s' "$3" > t/$1_t.txt; printf '%s' "$4" > t/$1_1.txt; printf '%s' "$5" > t/$1_2.txt
  ffmpeg -v error -y -f lavfi -i "color=c=0xfbf4e6:s=${W}x$((H+CH)):d=$2:r=25" -vf "drawtext=fontfile=$FB:textfile=t/$1_t.txt:fontcolor=0x3b2416:fontsize=64:x=(w-tw)/2:y=h/2-110,drawtext=fontfile=$F:textfile=t/$1_1.txt:fontcolor=0x8a4b1c:fontsize=28:x=(w-tw)/2:y=h/2+0,drawtext=fontfile=$F:textfile=t/$1_2.txt:fontcolor=0x5a4636:fontsize=24:x=(w-tw)/2:y=h/2+60,format=yuv420p" -c:v libx264 -crf 26 t/$1.mp4
}
card intro 3.5 "Nutcast" "Value for value, in ecash" "A Podcasting 2.0 player with a Cashu wallet in the page  ·  #NutNovember"
card mid 2.5 "Nutzaps" "Pay a show's Nostr wallet directly" "NIP-61 boosts and streaming, NIP-73 episode tags"
card outro 4.5 "Try it" "mmajjd926-netizen.github.io/nutcast" "Open source (MIT): github.com/mmajjd926-netizen/nutcast"
printf "file 'intro.mp4'\nfile 'A.mp4'\nfile 'mid.mp4'\nfile 'B.mp4'\nfile 'outro.mp4'\n" > t/list.txt
ffmpeg -v error -y -f concat -safe 0 -i t/list.txt -c:v libx264 -crf 27 -preset slow -movflags +faststart -pix_fmt yuv420p $R/public/walkthrough.mp4
ls -la $R/public/walkthrough.mp4
