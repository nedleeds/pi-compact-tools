#!/usr/bin/env bash
# Record the README's demo GIFs with vhs against a throwaway clone of this repository.
# Each tape runs a real Pi session with this checkout's extension and your default model.
#   scripts/record-demos.sh            # every demo
#   scripts/record-demos.sh silent-mode   # one demo
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export DEMO_DIR="${DEMO_DIR:-$HOME/Projects/pi-compact-tools-demo}"
cd "$root"
[ -d "$DEMO_DIR/.git" ] || git clone --quiet "$root" "$DEMO_DIR"
# The demo works on this checkout as it is now, committed there so each recording starts from it.
rsync -a --delete --exclude .git --exclude node_modules --exclude scripts/demos/out "$root/" "$DEMO_DIR/"
(cd "$DEMO_DIR" && git add -A && { git diff --cached --quiet || git commit --quiet -m "Demo snapshot"; })
[ -d "$DEMO_DIR/node_modules" ] || (cd "$DEMO_DIR" && npm ci --ignore-scripts --silent)
mkdir -p scripts/demos/out
style_of() { case "$1" in claude-style) echo claude;; codex-style) echo codex;; overview|compact-workflow|silent-mode) echo compact;; esac; }
for demo in "${@:-overview claude-style codex-style compact-workflow silent-mode}"; do
  for name in $demo; do
    # A clean demo checkout in the style the demo starts in, trusted for this run only by --approve.
    (cd "$DEMO_DIR" && git checkout --quiet -- . && git clean --quiet -fd -e node_modules)
    mkdir -p "$DEMO_DIR/.pi"
    printf '{\n  "style": "%s",\n  "tools": ["read", "write", "edit", "bash", "grep", "find", "ls"]\n}\n' "$(style_of "$name")" > "$DEMO_DIR/.pi/compact-tools.json"
    rm -rf "scripts/demos/out/$name"
    vhs "scripts/demos/$name.tape"
    # vhs saves text and cursor layers; ffmpeg 8+ no longer accepts the options vhs encodes GIFs with, so
    # they are joined here: the cursor over the text, framed in the theme's background at the tape's size,
    # with a full 256-color palette and no dithering so a one-character status dot keeps its color.
    ffmpeg -v error -y -framerate 24 -i "scripts/demos/out/$name/frame-text-%05d.png" \
      -framerate 24 -i "scripts/demos/out/$name/frame-cursor-%05d.png" \
      -filter_complex "[0][1]overlay,pad=iw+60:ih+42:(ow-iw)/2:(oh-ih)/2:color=0x101216,fps=12,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none" \
      "assets/$name.gif"
    echo "assets/$name.gif: $(du -h "assets/$name.gif" | cut -f1)"
  done
done
