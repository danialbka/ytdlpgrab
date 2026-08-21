# ytdlpgrab

![ytdlpgrab banner](src/assets/ytdlpgrab-banner.png)

Download the YouTube video you are currently watching and choose where to save it, or drag a thumbnail or video title out of Helium or Chrome. A small local macOS helper prepares the matching video as an MP4.

The goal is a Mac-like "grab the media" flow: start a drag from a YouTube thumbnail or title, drop it on the Desktop, and ytdlpgrab creates the MP4 there. A temporary `.mp4.download` item appears while the helper is fetching a new video, then it is replaced by the finished MP4.

## Features

- Menu-bar macOS app with a tiny `YT` status item.
- Local-only helper server on `127.0.0.1:17427`.
- Browser extension for YouTube thumbnail and video-title drags.
- One-click download for the currently watched YouTube video, Short, or live stream, with Chromium's Save As dialog.
- No visible badge or overlay on YouTube pages.
- Mode menu: YouTube Video MP4 or Audio M4A.
- Quality menu: Best, 4K, 1440p, 1080p, 720p, 480p, or 360p.
- MP4 output with video and audio merged through `yt-dlp` and `ffmpeg`.
- M4A output for audio-only mode.
- Completed-download cache in `~/Library/Caches/ytdlpgrab`.
- Start at Login toggle in the menu-bar app.

## How It Works

Helium and Chromium can block old-style `DownloadURL` drag payloads with a "Blocked by your organisation" message. ytdlpgrab avoids browser-managed downloads. The extension detects a completed thumbnail or title drag, sends the exact YouTube video URL to the local helper, and the helper writes the MP4 directly to the Desktop.

The extension popup can download the active YouTube video directly. Chromium opens its Save As dialog so you can choose the filename and destination. Dragging still only accepts actual YouTube video thumbnail/title links; if a drag target is ambiguous, it does nothing instead of guessing from the current page URL.

Each drag starts a background save request and returns immediately. Drag several different videos one by one and the helper will run the downloads in parallel instead of waiting for the previous one to finish.

## Requirements

- macOS 13 or newer
- Helium or a Chromium-based browser that can load unpacked extensions

The packaged app bundles the helper, `yt-dlp`, and a JavaScript runtime. Release builds also include `ffmpeg` when a usable binary is available at build time. If `ffmpeg` cannot run on a user's Mac, ytdlpgrab falls back to combined MP4 streams.

## Install From Release

For normal users, download both files from a release:

- `YTDLPGrab-<version>-arm64.dmg`
- `ytdlpgrab-extension-<version>.zip`

Open the DMG and drag `YTDLPGrab.app` into Applications. Then unzip the extension zip and load it in Helium or Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select the unzipped extension folder.

Open a YouTube video and choose **Download current video** from the extension popup. Choose the destination in Chromium's Save As dialog. You can also drag a thumbnail or video title and drop it on your Desktop.

If macOS blocks the app because it is unsigned, Control-click `YTDLPGrab.app`, choose **Open**, then confirm **Open**.

## Developer Requirements

- Node.js 18 or newer
- Xcode Command Line Tools with `swiftc`
- `ffmpeg` if you want release builds to include it

Install developer media tools with Homebrew:

```sh
brew install ffmpeg
```

## Install Media Downloader

ytdlpgrab can use either the official `yt-dlp` nightly binary or a local Python package install. The nightly binary is the simplest path for the menu-bar app:

```sh
npm run install:yt-dlp
```

Alternative Python install:

```sh
npm run install:yt-dlp:pip
```

You can also use a globally installed `yt-dlp`:

```sh
brew install yt-dlp
```

## Build The Mac App

```sh
npm run build:mac-app
```

This creates:

```sh
build/macos/YTDLPGrab.app
```

Install it into `/Applications` and open it:

```sh
npm run install:mac-app
```

The install script replaces `/Applications/YTDLPGrab.app` if it already exists.

## Build Release Artifacts

Build the DMG and extension zip:

```sh
npm run package:release
```

This creates:

```sh
YTDLPGrab-0.1.7-arm64.dmg
ytdlpgrab-extension-0.1.7.zip
```

`npm run package:dmg` builds only the DMG. `npm run package:extension` builds only the extension zip.

## Load The Extension

Open the menu-bar app, then choose **Open Extension Folder** from the `YT` menu. In Helium or Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select the `src/extension` folder.

Open a YouTube video and choose **Download current video** from the extension popup, then choose the filename and destination in Chromium's Save As dialog. You can also drag a thumbnail or video title and drop it on your Desktop; that drag flow still writes directly to `~/Desktop`.

## Menu Bar Controls

The `YT` menu includes:

- helper server status
- start and stop server
- mode selection for YouTube Video or Audio
- quality selection
- open Desktop
- open logs
- open extension folder
- Check for Updates / Install Update
- Start at Login toggle
- quit

If macOS needs approval for Start at Login, check System Settings -> General -> Login Items.

## Auto Updates

Both the macOS app and the browser extension check GitHub releases automatically.

The app checks shortly after launch and then every six hours. When a newer release is found, the `YT` menu shows **Install Update vN.N.N**; choosing it downloads the DMG from the release, replaces the app bundle, and relaunches. You can also trigger this any time with **Check for Updates...**.

The extension checks through the local helper on startup, every six hours, and whenever the popup opens. When an update is available, an **Update available** banner appears at the top of the popup; clicking it opens the release page where you can grab the latest extension ZIP (Chrome does not allow silent updates for unpacked extensions, so reload via `chrome://extensions` after unzipping).

## Development

Start the helper directly:

```sh
npm start
```

Check server health:

```sh
curl http://127.0.0.1:17427/health
```

Run syntax checks:

```sh
npm run check
```

Build the app:

```sh
npm run build:mac-app
```

## Legacy LaunchAgent

The menu-bar app is the preferred startup path. The older LaunchAgent scripts are still available if you want the server without the menu UI:

```sh
npm run install:launch-agent
```

Remove it:

```sh
npm run uninstall:launch-agent
```

Logs are written to `~/Library/Logs/ytdlpgrab.log` and `~/Library/Logs/ytdlpgrab.error.log`.

## Configuration

- `YTDLPGRAB_PORT=17427` changes the helper port.
- `YTDLPGRAB_CACHE_DIR=/path/to/cache` changes the cache folder.
- `YTDLPGRAB_MODE=audio` switches helper output to audio-only M4A. The default is `youtube` for MP4 video.
- `YTDLPGRAB_ALLOW_ANY_URL=1` allows non-YouTube URLs supported by `yt-dlp`.
- `YT_DLP_PATH=/path/to/yt-dlp` forces a specific `yt-dlp` executable.

The helper looks for `YT_DLP_PATH`, then `src/bin/yt-dlp`, then `.venv`, then common Homebrew/global `yt-dlp` installs.

## Repository Layout

- `src/extension` contains the browser extension.
- `src/server` contains the local helper server.
- `src/macos` contains the menu-bar app source.
- `src/scripts` contains development and packaging scripts.
- `src/assets` contains the README banner and source logo artwork.
- Release `.dmg` and extension `.zip` artifacts are written to the repo root.

## Notes

- The selected format prefers H.264 MP4 video plus AAC/M4A audio at or below the chosen quality, then falls back through `yt-dlp` best formats and remuxes to MP4.
- Audio mode prefers AAC/M4A audio and uses `ffmpeg` to extract M4A when available.
- Quality caps are applied to future downloads and cached separately.
- YouTube changes often break older downloader builds. Run `npm run install:yt-dlp` to refresh the bundled nightly binary.
- Use this only for content you have rights to download and in compliance with the sites you use.

## License

MIT
