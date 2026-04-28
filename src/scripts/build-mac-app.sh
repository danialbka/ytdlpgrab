#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$ROOT/src"
APP_NAME="YTDLPGrab"
BUILD_DIR="$ROOT/build/macos"
APP="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"

rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR/server" "$RESOURCES_DIR/extension" "$RESOURCES_DIR/bin"

realpath_for() {
  python3 - "$1" <<'PY'
import os
import sys

print(os.path.realpath(sys.argv[1]))
PY
}

copy_command_if_available() {
  local command_name="$1"
  local output_name="$2"
  local command_path

  command_path="$(command -v "$command_name" 2>/dev/null || true)"
  if [[ -z "$command_path" ]]; then
    return 0
  fi

  command_path="$(realpath_for "$command_path")"
  if [[ -x "$command_path" ]]; then
    cp "$command_path" "$RESOURCES_DIR/bin/$output_name"
    chmod +x "$RESOURCES_DIR/bin/$output_name"
  fi
}

swiftc \
  -O \
  -target arm64-apple-macos13.0 \
  -framework AppKit \
  -framework Foundation \
  -framework ServiceManagement \
  "$SRC_DIR/macos/YTDLPGrab/main.swift" \
  "$SRC_DIR/macos/YTDLPGrab/AppDelegate.swift" \
  -o "$MACOS_DIR/$APP_NAME"

cp "$SRC_DIR/macos/YTDLPGrab/Info.plist" "$CONTENTS/Info.plist"
cp "$SRC_DIR/server/index.js" "$RESOURCES_DIR/server/index.js"
cp -R "$SRC_DIR/extension/." "$RESOURCES_DIR/extension/"

if [[ -f "$SRC_DIR/macos/YTDLPGrab/AppIcon.icns" ]]; then
  cp "$SRC_DIR/macos/YTDLPGrab/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
fi

if [[ -x "$SRC_DIR/bin/yt-dlp" ]]; then
  cp "$SRC_DIR/bin/yt-dlp" "$RESOURCES_DIR/bin/yt-dlp"
  chmod +x "$RESOURCES_DIR/bin/yt-dlp"
fi

copy_command_if_available bun bun
if [[ ! -x "$RESOURCES_DIR/bin/bun" ]]; then
  copy_command_if_available node node
fi
copy_command_if_available ffmpeg ffmpeg
copy_command_if_available ffprobe ffprobe

if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
fi

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP" >/dev/null
fi

echo "Built $APP"
