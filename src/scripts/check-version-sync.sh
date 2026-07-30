#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"
PACKAGE_BUILD="$(cd "$ROOT" && node -p "require('./package.json').buildNumber")"
EXTENSION_VERSION="$(cd "$ROOT" && node -p "require('./src/extension/manifest.json').version")"
PLIST="$ROOT/src/macos/YTDLPGrab/Info.plist"
APP_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$PLIST")"
APP_BUILD="$(plutil -extract CFBundleVersion raw -o - "$PLIST")"

if [[ "$PACKAGE_VERSION" != "$EXTENSION_VERSION" ]]; then
  echo "Version mismatch: package.json=$PACKAGE_VERSION manifest.json=$EXTENSION_VERSION" >&2
  exit 1
fi

if [[ "$PACKAGE_VERSION" != "$APP_VERSION" ]]; then
  echo "Version mismatch: package.json=$PACKAGE_VERSION Info.plist=$APP_VERSION" >&2
  exit 1
fi

if [[ "$PACKAGE_BUILD" != "$APP_BUILD" ]]; then
  echo "Build mismatch: package.json=$PACKAGE_BUILD Info.plist=$APP_BUILD" >&2
  exit 1
fi

echo "Versions aligned: $PACKAGE_VERSION (build $PACKAGE_BUILD)"
