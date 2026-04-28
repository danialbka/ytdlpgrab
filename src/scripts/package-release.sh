#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$ROOT/src"

cd "$ROOT"
npm run check
"$SRC_DIR/scripts/package-extension.sh"
"$SRC_DIR/scripts/build-dmg.sh"

echo
echo "Release artifacts:"
find "$ROOT" -maxdepth 1 -type f \( -name "YTDLPGrab-*.dmg" -o -name "ytdlpgrab-extension-*.zip" \) -print | sort
