#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$ROOT/src"
APP_NAME="YTDLPGrab"
BUILT_APP="$ROOT/build/macos/$APP_NAME.app"
DEST_APP="/Applications/$APP_NAME.app"

if [[ ! -d "$BUILT_APP" ]]; then
  "$SRC_DIR/scripts/build-mac-app.sh"
fi

rm -rf "$DEST_APP"
cp -R "$BUILT_APP" "$DEST_APP"
open "$DEST_APP"

echo "Installed $DEST_APP"
