#!/usr/bin/env bash
set -euo pipefail
umask 022

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$ROOT/src"
VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"
APP_NAME="YTDLPGrab"
BUILD_DIR="$ROOT/build/macos"
APP="$BUILD_DIR/$APP_NAME.app"
STAGE_DIR="$BUILD_DIR/dmg-stage"
DMG_PATH="$ROOT/$APP_NAME-$VERSION-$(uname -m).dmg"
EXTENSION_ZIP="$ROOT/ytdlpgrab-extension-$VERSION.zip"

if [[ ! -x "$SRC_DIR/bin/yt-dlp" ]]; then
  echo "Missing bundled yt-dlp at src/bin/yt-dlp." >&2
  echo "Run: npm run install:yt-dlp" >&2
  exit 1
fi

"$SRC_DIR/scripts/build-mac-app.sh"

if [[ ! -f "$EXTENSION_ZIP" ]]; then
  "$SRC_DIR/scripts/package-extension.sh"
fi

rm -rf "$STAGE_DIR" "$DMG_PATH"
mkdir -p "$STAGE_DIR"

ditto "$APP" "$STAGE_DIR/$APP_NAME.app"
ln -s /Applications "$STAGE_DIR/Applications"
cp "$EXTENSION_ZIP" "$STAGE_DIR/"

cat > "$STAGE_DIR/README.txt" <<TXT
YTDLPGrab

1. Drag YTDLPGrab.app into Applications.
2. Open YTDLPGrab.app. It appears in the menu bar as "YT".
3. Unzip ytdlpgrab-extension-$VERSION.zip.
4. In Helium or Chrome, open chrome://extensions, enable Developer mode, and Load unpacked from the unzipped extension folder.
5. Open a YouTube video and choose "Download current video" from the extension popup, or drag a thumbnail or video title to the Desktop.

If macOS blocks the app because it is unsigned, Control-click the app, choose Open, then confirm Open.
TXT

hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGE_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

hdiutil verify "$DMG_PATH" >/dev/null
echo "Built $DMG_PATH"
