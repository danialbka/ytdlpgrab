#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="YTDLPGrab"
BUILD_DIR="$ROOT/build/macos"
APP="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"

rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR/server" "$RESOURCES_DIR/extension" "$RESOURCES_DIR/bin"

swiftc \
  -O \
  -target arm64-apple-macos13.0 \
  -framework AppKit \
  -framework Foundation \
  -framework ServiceManagement \
  "$ROOT/macos/YTDLPGrab/main.swift" \
  "$ROOT/macos/YTDLPGrab/AppDelegate.swift" \
  -o "$MACOS_DIR/$APP_NAME"

cp "$ROOT/macos/YTDLPGrab/Info.plist" "$CONTENTS/Info.plist"
cp "$ROOT/server/index.js" "$RESOURCES_DIR/server/index.js"
cp -R "$ROOT/extension/." "$RESOURCES_DIR/extension/"

if [[ -x "$ROOT/.venv/bin/python" ]] && "$ROOT/.venv/bin/python" -m yt_dlp --version >/dev/null 2>&1; then
  PYTHON_SITE="$("$ROOT/.venv/bin/python" - <<'PY'
import site

for path in site.getsitepackages():
    if path.endswith("site-packages"):
        print(path)
        break
PY
)"

  if [[ -n "$PYTHON_SITE" ]] && [[ -d "$PYTHON_SITE/yt_dlp" ]]; then
    mkdir -p "$RESOURCES_DIR/python"
    ditto "$PYTHON_SITE" "$RESOURCES_DIR/python"
  fi
fi

if [[ -x "$ROOT/bin/yt-dlp" ]]; then
  cp "$ROOT/bin/yt-dlp" "$RESOURCES_DIR/bin/yt-dlp"
  chmod +x "$RESOURCES_DIR/bin/yt-dlp"
fi

if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
fi

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP" >/dev/null
fi

echo "Built $APP"
