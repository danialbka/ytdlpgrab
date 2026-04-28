#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN_DIR="$ROOT/src/bin"
TARGET="$BIN_DIR/yt-dlp"
API_URL="https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest"

case "$(uname -s)-$(uname -m)" in
  Darwin-*)
    ASSET_NAME="${YTDLPGRAB_YTDLP_ASSET:-yt-dlp_macos}"
    ;;
  Linux-aarch64|Linux-arm64)
    ASSET_NAME="${YTDLPGRAB_YTDLP_ASSET:-yt-dlp_linux_aarch64}"
    ;;
  Linux-*)
    ASSET_NAME="${YTDLPGRAB_YTDLP_ASSET:-yt-dlp_linux}"
    ;;
  *)
    ASSET_NAME="${YTDLPGRAB_YTDLP_ASSET:-yt-dlp}"
    ;;
esac

mkdir -p "$BIN_DIR"

read -r ASSET_URL SUMS_URL TAG_NAME < <(
  python3 - "$API_URL" "$ASSET_NAME" <<'PY'
import json
import sys
import urllib.request

api_url, asset_name = sys.argv[1:3]
with urllib.request.urlopen(api_url) as response:
    release = json.load(response)

assets = {asset["name"]: asset["browser_download_url"] for asset in release["assets"]}
try:
    print(assets[asset_name], assets["SHA2-256SUMS"], release["tag_name"])
except KeyError as error:
    raise SystemExit(f"Missing release asset: {error}") from error
PY
)

TMP_FILE="$(mktemp)"
SUMS_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE" "$SUMS_FILE"' EXIT

echo "Downloading yt-dlp nightly $TAG_NAME ($ASSET_NAME)"
curl -fsSL "$ASSET_URL" -o "$TMP_FILE"
curl -fsSL "$SUMS_URL" -o "$SUMS_FILE"

EXPECTED="$(awk -v name="$ASSET_NAME" '$2 == name { print $1 }' "$SUMS_FILE")"
ACTUAL="$(shasum -a 256 "$TMP_FILE" | awk '{ print $1 }')"

if [[ -z "$EXPECTED" ]]; then
  echo "Could not find $ASSET_NAME in SHA2-256SUMS" >&2
  exit 1
fi

if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "Checksum mismatch for $ASSET_NAME" >&2
  exit 1
fi

mv "$TMP_FILE" "$TARGET"
chmod +x "$TARGET"
"$TARGET" --version
