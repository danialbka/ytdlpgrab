#!/usr/bin/env bash
set -euo pipefail
umask 022

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$ROOT/src"
VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"
BUILD_NUMBER="$(cd "$ROOT" && node -p "require('./package.json').buildNumber")"
APP_NAME="YTDLPGrab"
BUILD_DIR="$ROOT/build/macos"
APP="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"
LIB_DIR="$RESOURCES_DIR/lib"

rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR/server" "$RESOURCES_DIR/extension" "$RESOURCES_DIR/bin" "$LIB_DIR"

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

non_system_dylib_dependencies() {
  local file_path="$1"

  if ! command -v otool >/dev/null 2>&1; then
    return 0
  fi

  otool -L "$file_path" 2>/dev/null | awk 'NR > 1 { print $1 }' | while IFS= read -r dep_path; do
    case "$dep_path" in
      /System/Library/*|/usr/lib/*|@*)
        continue
        ;;
    esac

    if [[ -f "$dep_path" ]]; then
      echo "$dep_path"
    fi
  done
}

bundled_dylib_path_for() {
  local dep_path="$1"
  local real_dep

  real_dep="$(realpath_for "$dep_path")"
  echo "$LIB_DIR/$(basename "$real_dep")"
}

enqueue_dylib_dependency() {
  local dep_path="$1"
  local destination

  destination="$(bundled_dylib_path_for "$dep_path")"
  if [[ ! -f "$destination" ]]; then
    cp "$(realpath_for "$dep_path")" "$destination"
    chmod u+w "$destination"
    echo "$destination" >> "$DYLIB_QUEUE"
  fi
}

rewrite_dylib_references() {
  local file_path="$1"
  local relative_prefix="$2"
  local dep_path
  local destination
  local rewritten_path

  if ! command -v install_name_tool >/dev/null 2>&1; then
    return 0
  fi

  non_system_dylib_dependencies "$file_path" | while IFS= read -r dep_path; do
    destination="$(bundled_dylib_path_for "$dep_path")"
    if [[ ! -f "$destination" ]]; then
      continue
    fi

    rewritten_path="@loader_path/$relative_prefix$(basename "$destination")"
    install_name_tool -change "$dep_path" "$rewritten_path" "$file_path"
  done
}

bundle_mach_o_dependencies() {
  local binary_path="$1"
  local index=1
  local queued_dylib
  local dep_path

  if [[ ! -f "$binary_path" ]] || ! command -v otool >/dev/null 2>&1; then
    return 0
  fi

  DYLIB_QUEUE="$(mktemp)"
  DYLIB_PROCESSED="$(mktemp)"
  trap 'rm -f "$DYLIB_QUEUE" "$DYLIB_PROCESSED"' EXIT

  non_system_dylib_dependencies "$binary_path" | while IFS= read -r dep_path; do
    enqueue_dylib_dependency "$dep_path"
  done

  while true; do
    queued_dylib="$(sed -n "${index}p" "$DYLIB_QUEUE")"
    if [[ -z "$queued_dylib" ]]; then
      break
    fi
    index=$((index + 1))

    if grep -Fqx "$queued_dylib" "$DYLIB_PROCESSED"; then
      continue
    fi
    echo "$queued_dylib" >> "$DYLIB_PROCESSED"

    non_system_dylib_dependencies "$queued_dylib" | while IFS= read -r dep_path; do
      enqueue_dylib_dependency "$dep_path"
    done
  done

  rewrite_dylib_references "$binary_path" "../lib/"

  if command -v install_name_tool >/dev/null 2>&1; then
    find "$LIB_DIR" -type f -name "*.dylib" -print | while IFS= read -r queued_dylib; do
      install_name_tool -id "@loader_path/$(basename "$queued_dylib")" "$queued_dylib" || true
      rewrite_dylib_references "$queued_dylib" ""
    done
  fi

  rm -f "$DYLIB_QUEUE" "$DYLIB_PROCESSED"
  trap - EXIT
}

sign_mach_o_file() {
  local file_path="$1"

  if ! command -v codesign >/dev/null 2>&1 || ! command -v file >/dev/null 2>&1; then
    return 0
  fi

  if file "$file_path" | grep -q "Mach-O"; then
    codesign --force --sign - "$file_path" >/dev/null
  fi
}

sign_bundled_mach_o_files() {
  if ! command -v codesign >/dev/null 2>&1; then
    return 0
  fi

  find "$RESOURCES_DIR/bin" "$LIB_DIR" -type f -print | while IFS= read -r file_path; do
    sign_mach_o_file "$file_path"
  done
}

if [[ ! -x "$SRC_DIR/bin/yt-dlp" ]]; then
  echo "Warning: yt-dlp not found at $SRC_DIR/bin/yt-dlp" >&2
  echo "The app will lack yt-dlp. Run: npm run install:yt-dlp" >&2
fi

swiftc \
  -O \
  -target "$(uname -m)-apple-macos13.0" \
  -framework AppKit \
  -framework Foundation \
  -framework ServiceManagement \
  "$SRC_DIR/macos/YTDLPGrab/main.swift" \
  "$SRC_DIR/macos/YTDLPGrab/AppDelegate.swift" \
  -o "$MACOS_DIR/$APP_NAME"

cp "$SRC_DIR/macos/YTDLPGrab/Info.plist" "$CONTENTS/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$CONTENTS/Info.plist"
plutil -replace CFBundleVersion -string "$BUILD_NUMBER" "$CONTENTS/Info.plist"
cp "$SRC_DIR/server/index.js" "$RESOURCES_DIR/server/index.js"
cp -R "$SRC_DIR/extension/." "$RESOURCES_DIR/extension/"
printf '%s' "$VERSION" > "$RESOURCES_DIR/version"

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

bundle_mach_o_dependencies "$RESOURCES_DIR/bin/ffmpeg"
bundle_mach_o_dependencies "$RESOURCES_DIR/bin/ffprobe"
sign_bundled_mach_o_files

if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
fi

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP" >/dev/null
fi

echo "Built $APP"
