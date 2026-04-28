#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(node -p "require('./package.json').version")"
ZIP_PATH="$ROOT/ytdlpgrab-extension-$VERSION.zip"

rm -f "$ZIP_PATH"

(
  cd "$ROOT/src/extension"
  zip -r -X "$ZIP_PATH" \
    manifest.json \
    content.js \
    content.css \
    popup.html \
    popup.js \
    icons >/dev/null
)

unzip -t "$ZIP_PATH" >/dev/null
echo "Built $ZIP_PATH"
