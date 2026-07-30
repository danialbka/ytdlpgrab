#!/usr/bin/env bash
set -euo pipefail
umask 022

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"
ZIP_PATH="$ROOT/ytdlpgrab-extension-$VERSION.zip"

rm -f "$ZIP_PATH"

(
  cd "$ROOT/src/extension"
  zip -r -X "$ZIP_PATH" \
    manifest.json \
    background.js \
    content.js \
    content.css \
    popup.html \
    popup.js \
    icons \
    -x "*.DS_Store" >/dev/null
)

unzip -t "$ZIP_PATH" >/dev/null
echo "Built $ZIP_PATH"
