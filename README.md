# ytdlpgrab

Drag a YouTube thumbnail out of Helium or Chrome and let a small local macOS helper save the matching video as an MP4 on your Desktop.

The goal is a Mac-like "grab the media" flow: start a drag from a YouTube thumbnail, drop it on the Desktop, and ytdlpgrab creates the MP4 there. A temporary `.mp4.download` item appears while the helper is fetching a new video, then it is replaced by the finished MP4.

## Features

- Menu-bar macOS app with a tiny `YT` status item.
- Local-only helper server on `127.0.0.1:17427`.
- Browser extension for YouTube thumbnail drags.
- No visible badge or overlay on YouTube pages.
- Quality menu: Best, 4K, 1440p, 1080p, 720p, 480p, or 360p.
- MP4 output with video and audio merged through `yt-dlp` and `ffmpeg`.
- Completed-download cache in `~/Library/Caches/ytdlpgrab`.
- Start at Login toggle in the menu-bar app.

## How It Works

Helium and Chromium can block old-style `DownloadURL` drag payloads with a "Blocked by your organisation" message. ytdlpgrab avoids browser-managed downloads. The extension detects a completed thumbnail drag, sends the exact YouTube video URL to the local helper, and the helper writes the MP4 directly to the Desktop.

The extension only accepts actual YouTube thumbnail links. If a drag target is ambiguous, it does nothing instead of guessing from the current page URL.

## Requirements

- macOS 13 or newer
- Node.js 18 or newer
- Xcode Command Line Tools with `swiftc`
- `ffmpeg`
- Helium or a Chromium-based browser that can load unpacked extensions

Install `ffmpeg` with Homebrew:

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

## Load The Extension

Open the menu-bar app, then choose **Open Extension Folder** from the `YT` menu. In Helium or Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select the `extension` folder.

Open YouTube, drag a thumbnail, and drop it on your Desktop. The helper writes the MP4 directly to `~/Desktop`.

## Menu Bar Controls

The `YT` menu includes:

- helper server status
- start and stop server
- quality selection
- open Desktop
- open logs
- open extension folder
- Start at Login toggle
- quit

If macOS needs approval for Start at Login, check System Settings -> General -> Login Items.

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
- `YTDLPGRAB_ALLOW_ANY_URL=1` allows non-YouTube URLs supported by `yt-dlp`.
- `YT_DLP_PATH=/path/to/yt-dlp` forces a specific `yt-dlp` executable.

The helper looks for `YT_DLP_PATH`, then `bin/yt-dlp`, then `.venv`, then common Homebrew/global `yt-dlp` installs.

## Notes

- The selected format prefers MP4 video plus M4A audio at or below the chosen quality, then falls back through `yt-dlp` best formats and remuxes to MP4.
- Quality caps are applied to future downloads and cached separately.
- YouTube changes often break older downloader builds. Run `npm run install:yt-dlp` to refresh the bundled nightly binary.
- Use this only for content you have rights to download and in compliance with the sites you use.

## License

MIT
