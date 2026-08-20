const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const installerSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "scripts", "install-yt-dlp-nightly.sh"),
  "utf8"
);

test("macOS Apple Silicon uses the current universal yt-dlp asset", () => {
  assert.match(
    installerSource,
    /Darwin-arm64\|Darwin-aarch64\)[\s\S]*?YTDLPGRAB_YTDLP_ASSET:-yt-dlp_macos}/
  );
  assert.doesNotMatch(installerSource, /yt-dlp_macos_arm64/);
});
