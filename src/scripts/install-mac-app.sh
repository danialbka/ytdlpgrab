#!/usr/bin/env bash
set -euo pipefail
umask 022

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$ROOT/src"
APP_NAME="YTDLPGrab"
BUILT_APP="$ROOT/build/macos/$APP_NAME.app"
DEST_APP="/Applications/$APP_NAME.app"

if [[ ! -d "$BUILT_APP" ]]; then
  "$SRC_DIR/scripts/build-mac-app.sh"
fi

if [[ $EUID -eq 0 ]]; then
  rm -rf "$DEST_APP"
  cp -R "$BUILT_APP" "$DEST_APP"
else
  sudo rm -rf "$DEST_APP"
  sudo cp -R "$BUILT_APP" "$DEST_APP"
fi
open "$DEST_APP"

echo "Installed $DEST_APP"
