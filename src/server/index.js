#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT =
  path.basename(PROJECT_ROOT) === "src"
    ? path.resolve(PROJECT_ROOT, "..")
    : PROJECT_ROOT;
const BUNDLED_PYTHON_DIR = path.join(PROJECT_ROOT, "python");
const BUNDLED_BIN_DIR = path.join(PROJECT_ROOT, "bin");
const HOST = process.env.YTDLPGRAB_HOST || "127.0.0.1";
const PORT = positiveIntegerFromValue(process.env.YTDLPGRAB_PORT || process.env.PORT, 17427);
const CACHE_DIR =
  process.env.YTDLPGRAB_CACHE_DIR ||
  path.join(os.homedir(), "Library", "Caches", "ytdlpgrab");
const ALLOW_ANY_URL = process.env.YTDLPGRAB_ALLOW_ANY_URL === "1";
const TRUSTED_ACTION_HEADER = "x-ytdlpgrab-extension";
const TRUSTED_ACTION_VALUE = "1";
const DOWNLOAD_TIMEOUT_MS = positiveIntegerFromValue(
  process.env.YTDLPGRAB_TIMEOUT_MS, 60 * 60 * 1000
);
const TOOL_CHECK_TIMEOUT_MS = positiveIntegerFromValue(
  process.env.YTDLPGRAB_TOOL_CHECK_TIMEOUT_MS, 3000
);
const YT_DLP_HELP_TIMEOUT_MS = positiveIntegerFromValue(
  process.env.YTDLPGRAB_YTDLP_HELP_TIMEOUT_MS, 30 * 1000
);
const TOOL_CACHE_TTL_MS = positiveIntegerFromValue(
  process.env.YTDLPGRAB_TOOL_CACHE_TTL_MS, 30 * 1000
);
const MAX_ACTIVE_DOWNLOADS = positiveIntegerFromValue(
  process.env.YTDLPGRAB_MAX_ACTIVE_DOWNLOADS,
  3
);
const QUALITY_OPTIONS = new Map([
  ["best", { label: "Best available", height: null }],
  ["2160", { label: "4K / 2160p", height: 2160 }],
  ["1440", { label: "1440p", height: 1440 }],
  ["1080", { label: "1080p", height: 1080 }],
  ["720", { label: "720p", height: 720 }],
  ["480", { label: "480p", height: 480 }],
  ["360", { label: "360p", height: 360 }]
]);
const DOWNLOAD_MODE_OPTIONS = new Map([
  [
    "youtube",
    {
      label: "YouTube Video",
      extension: "mp4",
      contentType: "video/mp4",
      cacheProfile: "youtube-mp4-h264-aac-v1"
    }
  ],
  [
    "audio",
    {
      label: "Audio",
      extension: "m4a",
      contentType: "audio/mp4",
      cacheProfile: "audio-m4a-aac-v1"
    }
  ]
]);
const QUALITY = qualityFromValue(process.env.YTDLPGRAB_QUALITY);
const DOWNLOAD_MODE = modeFromValue(process.env.YTDLPGRAB_MODE);

const jobs = new Map();
const saveJobs = new Map();
const progressListeners = new Map();
const downloadQueue = [];
let activeDownloads = 0;
const toolCache = {
  ytDlp: { checkedAt: 0, value: undefined },
  ffmpeg: { checkedAt: 0, value: undefined },
  jsRuntimes: { checkedAt: 0, value: undefined },
  ytDlpSupportsJsRuntimes: { checkedAt: 0, value: undefined }
};

if (fs.existsSync(BUNDLED_PYTHON_DIR)) {
  process.env.PYTHONPATH = process.env.PYTHONPATH
    ? `${BUNDLED_PYTHON_DIR}${path.delimiter}${process.env.PYTHONPATH}`
    : BUNDLED_PYTHON_DIR;
}

function positiveIntegerFromValue(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isAllowedExtensionOrigin(origin) {
  return (
    typeof origin === "string" &&
    (origin.startsWith("chrome-extension://") ||
      origin.startsWith("moz-extension://"))
  );
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!isAllowedExtensionOrigin(origin)) {
    return;
  }

  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    `content-type, ${TRUSTED_ACTION_HEADER}`
  );
  res.setHeader("vary", "origin");
}

function isTrustedActionRequest(req) {
  const origin = req.headers.origin;
  if (origin && !isAllowedExtensionOrigin(origin)) {
    return false;
  }

  return req.headers[TRUSTED_ACTION_HEADER] === TRUSTED_ACTION_VALUE;
}

function requireTrustedAction(req, res) {
  if (isTrustedActionRequest(req)) {
    return true;
  }

  sendError(res, 403, "Request is missing the trusted extension header.");
  return false;
}

function sendMethodNotAllowed(res, allowedMethods) {
  res.setHeader("allow", allowedMethods.join(", "));
  sendError(res, 405, `Method not allowed. Allowed: ${allowedMethods.join(", ")}.`);
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, statusCode, message, detail) {
  sendJson(res, statusCode, {
    ok: false,
    error: message,
    detail: detail || undefined
  });
}

function sanitizeFileName(value) {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|#%{}$!`+=@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return Array.from(cleaned).slice(0, 120).join("") || "youtube-video";
}

function withOutputExtension(name) {
  const extension = modeOptionFor(DOWNLOAD_MODE).extension;
  const base = sanitizeFileName(name).replace(/\.[a-z0-9]{1,5}$/i, "");
  return `${base}.${extension}`;
}

function contentDisposition(filename) {
  const unicodeName = withOutputExtension(filename);
  const asciiName = unicodeName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/[";]/g, " ");
  const encodedName = encodeURIComponent(unicodeName);
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

function outputDirectoryForDestination(destination) {
  const normalized = String(destination || "desktop").toLowerCase();

  if (normalized === "downloads") {
    return path.join(os.homedir(), "Downloads");
  }

  return path.join(os.homedir(), "Desktop");
}

function parseRequestedUrl(value) {
  if (!value) {
    throw new Error("Missing url parameter.");
  }

  if (value.length > 4096) {
    throw new Error("URL parameter exceeds maximum length.");
  }

  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }

  if (ALLOW_ANY_URL) {
    return parsed.toString();
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const allowedHosts = new Set([
    "youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be"
  ]);

  if (!allowedHosts.has(host)) {
    throw new Error("Only YouTube URLs are accepted by default.");
  }

  return parsed.toString();
}

function qualityFromValue(value) {
  const normalized = String(value || "best").toLowerCase().replace(/p\d*$/, "");
  return QUALITY_OPTIONS.has(normalized) ? normalized : "best";
}

function qualityLabelFor(quality) {
  return QUALITY_OPTIONS.get(quality)?.label || QUALITY_OPTIONS.get("best").label;
}

function modeFromValue(value) {
  const normalized = String(value || "youtube").toLowerCase();
  return DOWNLOAD_MODE_OPTIONS.has(normalized) ? normalized : "youtube";
}

function modeOptionFor(mode) {
  return DOWNLOAD_MODE_OPTIONS.get(mode) || DOWNLOAD_MODE_OPTIONS.get("youtube");
}

function modeLabelFor(mode) {
  return modeOptionFor(mode).label;
}

function formatSelectorForQuality(quality, canMerge = true) {
  const option = QUALITY_OPTIONS.get(quality) || QUALITY_OPTIONS.get("best");
  const compatibleVideo = "[ext=mp4][vcodec^=avc1]";
  const compatibleAudio = "[ext=m4a][acodec^=mp4a]";
  const compatibleMuxed = "[ext=mp4][vcodec^=avc1][acodec^=mp4a]";

  if (!canMerge) {
    if (!option.height) {
      return `b${compatibleMuxed}/b${compatibleVideo}/best[ext=mp4]`;
    }

    const height = option.height;
    return [
      `b[height<=${height}]${compatibleMuxed}`,
      `b[height<=${height}]${compatibleVideo}`,
      `best[height<=${height}][ext=mp4]`,
      `b[height<=${height}]`
    ].join("/");
  }

  if (!option.height) {
    return [
      `bv*${compatibleVideo}+ba${compatibleAudio}`,
      `b${compatibleMuxed}`,
      "bv*[ext=mp4]+ba[ext=m4a]",
      "b[ext=mp4]",
      "bv*+ba/b"
    ].join("/");
  }

  const height = option.height;
  return [
    `bv*[height<=${height}]${compatibleVideo}+ba${compatibleAudio}`,
    `b[height<=${height}]${compatibleMuxed}`,
    `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
    `b[height<=${height}][ext=mp4]`,
    `bv*[height<=${height}]+ba`,
    `b[height<=${height}]`,
    `best[height<=${height}]`
  ].join("/");
}

function audioFormatSelector(canTranscode = true) {
  if (canTranscode) {
    return "ba[ext=m4a][acodec^=mp4a]/ba[ext=m4a]/bestaudio";
  }

  return "ba[ext=m4a][acodec^=mp4a]/ba[ext=m4a]";
}

function formatSelectorForMode(mode, quality, canMerge = true) {
  if (mode === "audio") {
    return audioFormatSelector(canMerge);
  }

  return formatSelectorForQuality(quality, canMerge);
}

function cacheKeyFor(videoUrl) {
  const modeOption = modeOptionFor(DOWNLOAD_MODE);
  const ffmpeg = resolveFfmpeg();
  return crypto
    .createHash("sha256")
    .update(
      [
        videoUrl,
        `mode=${DOWNLOAD_MODE}`,
        `quality=${QUALITY}`,
        `format=${modeOption.cacheProfile}`,
        `ffmpeg=${Boolean(ffmpeg)}`
      ].join("\n")
    )
    .digest("hex");
}

function cachedPathFor(key) {
  return path.join(CACHE_DIR, `${key}.${modeOptionFor(DOWNLOAD_MODE).extension}`);
}

function cacheGet(key, resolver) {
  const entry = toolCache[key];
  const now = Date.now();

  if (entry.value !== undefined && now - entry.checkedAt < TOOL_CACHE_TTL_MS) {
    return entry.value;
  }

  const prevCheckedAt = entry.checkedAt;
  entry.checkedAt = now;
  try {
    entry.value = resolver();
    return entry.value;
  } catch (error) {
    entry.checkedAt = prevCheckedAt;
    throw error;
  }
}

function resolveCommand(command, args = [], versionFlag = "--version") {
  const result = spawnSync(command, [...args, versionFlag], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TOOL_CHECK_TIMEOUT_MS
  });

  if (!result.error && result.status === 0) {
    return {
      command,
      args,
      version: String(result.stdout || result.stderr).trim().split(/\s+/)[0]
    };
  }

  return null;
}

function resolveExecutableCommand(command, args = [], version = "available") {
  if (!executableExists(command)) {
    return null;
  }

  return {
    command,
    args,
    version
  };
}

function resolveYtDlp() {
  return cacheGet("ytDlp", () => {
    if (process.env.YT_DLP_PATH) {
      const resolved = resolveCommand(process.env.YT_DLP_PATH);
      if (resolved) {
        return resolved;
      }
    }

    const localBinary = path.join(PROJECT_ROOT, "bin", "yt-dlp");
    const resolvedLocalBinary = resolveExecutableCommand(
      localBinary,
      [],
      "bundled"
    );
    if (resolvedLocalBinary) {
      return resolvedLocalBinary;
    }

    const localPython = path.join(REPO_ROOT, ".venv", "bin", "python");
    if (fs.existsSync(localPython)) {
      const resolved = resolveCommand(localPython, ["-m", "yt_dlp"]);
      if (resolved) {
        return resolved;
      }
    }

    if (fs.existsSync(path.join(BUNDLED_PYTHON_DIR, "yt_dlp"))) {
      for (const candidate of [
        "/Library/Developer/CommandLineTools/usr/bin/python3",
        "/usr/bin/python3",
        "python3"
      ]) {
        const resolved = resolveCommand(candidate, ["-m", "yt_dlp"]);
        if (resolved) {
          return resolved;
        }
      }
    }

    for (const candidate of [
      "/opt/homebrew/bin/yt-dlp",
      "/usr/local/bin/yt-dlp",
      "yt-dlp"
    ]) {
      const resolved = resolveCommand(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return resolveCommand("python3", ["-m", "yt_dlp"]);
  });
}

function resolveBinary(command) {
  const result = spawnSync(command, ["-version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TOOL_CHECK_TIMEOUT_MS
  });

  if (!result.error && result.status === 0) {
    return String(result.stdout || result.stderr).trim().split(/\s+/)[2] || "available";
  }

  return null;
}

function resolveFfmpeg() {
  return cacheGet("ffmpeg", () => {
    for (const candidate of [
      path.join(BUNDLED_BIN_DIR, "ffmpeg"),
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "ffmpeg"
    ]) {
      const version = resolveBinary(candidate);
      if (version) {
        return {
          command: candidate,
          version
        };
      }
    }

    return null;
  });
}

function executableExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimePath(command, candidates) {
  for (const candidate of candidates) {
    if (executableExists(candidate)) {
      return candidate;
    }
  }

  const result = spawnSync("/usr/bin/env", [command, "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TOOL_CHECK_TIMEOUT_MS
  });

  return !result.error && result.status === 0 ? command : null;
}

function resolveJavaScriptRuntimes() {
  return cacheGet("jsRuntimes", () => {
    const runtimes = [];
    const nodePath = resolveRuntimePath("node", [
      path.join(BUNDLED_BIN_DIR, "node"),
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node"
    ]);
    const bunPath = resolveRuntimePath("bun", [
      path.join(BUNDLED_BIN_DIR, "bun"),
      "/opt/homebrew/bin/bun",
      "/usr/local/bin/bun"
    ]);

    if (nodePath) {
      runtimes.push(`node:${nodePath}`);
    }

    if (bunPath) {
      runtimes.push(`bun:${bunPath}`);
    }

    return runtimes;
  });
}

function ytDlpSupportsJavaScriptRuntimes(ytDlp) {
  return cacheGet("ytDlpSupportsJsRuntimes", () => {
    const result = spawnSync(ytDlp.command, [...ytDlp.args, "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: YT_DLP_HELP_TIMEOUT_MS
    });

    if (result.error || result.status !== 0) {
      return false;
    }

    return String(result.stdout || result.stderr).includes("--js-runtimes");
  });
}

function ytDlpJavaScriptArgs(ytDlp) {
  if (!ytDlpSupportsJavaScriptRuntimes(ytDlp)) {
    return [];
  }

  return resolveJavaScriptRuntimes().flatMap((runtime) => [
    "--js-runtimes",
    runtime
  ]);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stderrRemainder = "";
    let settled = false;
    const maxOutput = options.maxOutput || 2 * 1024 * 1024;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Command timed out after ${options.timeoutMs}ms.`));
      }
    }, options.timeoutMs || DOWNLOAD_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < maxOutput) {
        stdout += chunk.toString();
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      if (stderr.length < maxOutput) {
        stderr += text;
      }

      if (typeof options.onStderrLine === "function") {
        const lines = `${stderrRemainder}${text}`.split(/\r?\n/);
        stderrRemainder = lines.pop() || "";
        for (const line of lines) {
          options.onStderrLine(line);
        }
      }
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      if (stderrRemainder && typeof options.onStderrLine === "function") {
        options.onStderrLine(stderrRemainder);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${path.basename(command)} exited with ${code}.\n${stderr}`.trim()
          )
        );
      }
    });
  });
}

async function findDownloadedFile(workDir, baseName, stdout) {
  const extension = `.${modeOptionFor(DOWNLOAD_MODE).extension}`;
  const printedPath = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => path.isAbsolute(line))
    .pop();

  if (
    printedPath &&
    printedPath.toLowerCase().endsWith(extension) &&
    fs.existsSync(printedPath)
  ) {
    return printedPath;
  }

  const entries = await fsp.readdir(workDir);
  const candidates = (
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry === `${baseName}${extension}` ||
            entry.startsWith(`${baseName}.`)
        )
        .filter((entry) => !entry.endsWith(".part") && !entry.endsWith(".ytdl"))
        .map(async (entry) => {
          const fullPath = path.join(workDir, entry);
          try {
            const stat = await fsp.stat(fullPath);
            return stat.isFile() ? fullPath : null;
          } catch {
            return null;
          }
        })
    )
  ).filter(Boolean);

  const preferred = candidates.find((entry) =>
    entry.toLowerCase().endsWith(extension)
  );
  return preferred || candidates[0];
}

async function removeQuietly(filePath) {
  try {
    await fsp.rm(filePath, { recursive: true, force: true });
  } catch (error) {
    console.error(`[ytdlpgrab] remove failed: ${error.message}`);
  }
}

async function uniqueOutputPath(directory, filename) {
  const safeName = withOutputExtension(filename);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);

  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : ` ${index}`;
    const candidate = path.join(directory, `${base}${suffix}${ext}`);
    const placeholder = `${candidate}.download`;

    try {
      await fsp.access(candidate);
      continue;
    } catch {
      // Keep looking if an in-progress placeholder already owns this name.
    }

    try {
      await fsp.access(placeholder);
    } catch {
      return candidate;
    }
  }

  return path.join(directory, `${base} ${Date.now()}${ext}`);
}

function downloadInfoPlist(targetPath, videoUrl, progress = {}) {
  const bytesSoFar = Math.max(0, Math.floor(progress.bytesSoFar || 0));
  const totalBytes = Math.max(0, Math.floor(progress.totalBytes || 0));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>DownloadEntryPath</key>',
    `  <string>${escapePlistString(targetPath)}</string>`,
    '  <key>DownloadEntryURL</key>',
    `  <string>${escapePlistString(videoUrl)}</string>`,
    '  <key>DownloadEntryProgressBytesSoFar</key>',
    `  <integer>${bytesSoFar}</integer>`,
    '  <key>DownloadEntryProgressTotalToLoad</key>',
    `  <integer>${totalBytes}</integer>`,
    '</dict>',
    '</plist>',
    ''
  ].join("\n");
}

async function writeDownloadPlaceholderInfo(
  placeholderPath,
  targetPath,
  videoUrl,
  progress
) {
  await fsp.writeFile(
    path.join(placeholderPath, "Info.plist"),
    downloadInfoPlist(targetPath, videoUrl, progress)
  );
}

async function createDownloadPlaceholder(targetPath, videoUrl) {
  const placeholderPath = `${targetPath}.download`;
  await fsp.mkdir(placeholderPath);
  try {
    await writeDownloadPlaceholderInfo(placeholderPath, targetPath, videoUrl, {
      bytesSoFar: 0,
      totalBytes: 0
    });
  } catch (error) {
    await removeQuietly(placeholderPath);
    throw error;
  }

  return placeholderPath;
}

function escapePlistString(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&apos;")
    .replace(/"/g, "&quot;");
}

function bytesFromYtDlpSize(value, unit) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return 0;
  }

  const normalizedUnit = String(unit || "B").toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4
  };

  return Math.round(amount * (multipliers[normalizedUnit] || 1));
}

function parseYtDlpProgressLine(line) {
  const text = String(line || "");
  if (!text.includes("[download]")) {
    return null;
  }

  const match = text.match(
    /\[download\]\s+([0-9]+(?:\.[0-9]+)?)%\s+of\s+~?\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B|[KMGT]?B)\b/i
  );
  if (!match) {
    return null;
  }

  const percent = Math.min(100, Math.max(0, Number(match[1])));
  const totalBytes = bytesFromYtDlpSize(match[2], match[3]);
  const bytesSoFar = totalBytes ? Math.round((totalBytes * percent) / 100) : 0;

  return {
    bytesSoFar,
    totalBytes
  };
}

function emitDownloadProgress(key, progress) {
  const listeners = progressListeners.get(key);
  if (!listeners) {
    return;
  }

  for (const listener of [...listeners]) {
    listener(progress);
  }
}

function addDownloadProgressListener(key, listener) {
  let listeners = progressListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    progressListeners.set(key, listeners);
  }

  listeners.add(listener);
  const capturedKey = key;
  return () => {
    const current = progressListeners.get(capturedKey);
    if (current) {
      current.delete(listener);
      if (current.size === 0) {
        progressListeners.delete(capturedKey);
      }
    }
  };
}

async function downloadWithYtDlp(videoUrl, key) {
  const ytDlp = resolveYtDlp();
  if (!ytDlp) {
    throw new Error(
      "yt-dlp is not installed. Run npm run install:yt-dlp or brew install yt-dlp ffmpeg."
    );
  }

  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ytdlpgrab-"));
  const baseName = key;
  const outputTemplate = path.join(workDir, `${baseName}.%(ext)s`);
  const targetPath = cachedPathFor(key);
  const ffmpeg = resolveFfmpeg();

  const args = [
    ...ytDlp.args,
    ...ytDlpJavaScriptArgs(ytDlp),
    "--no-playlist",
    "--no-mtime",
    "--newline",
    "-f",
    formatSelectorForMode(DOWNLOAD_MODE, QUALITY, Boolean(ffmpeg)),
    "--print",
    "after_move:filepath",
    "-o",
    outputTemplate,
    videoUrl
  ];

  if (ffmpeg && DOWNLOAD_MODE === "audio") {
    args.splice(
      args.length - 1,
      0,
      "--ffmpeg-location",
      path.dirname(ffmpeg.command),
      "--extract-audio",
      "--audio-format",
      "m4a",
      "--audio-quality",
      "0"
    );
  } else if (ffmpeg) {
    args.splice(
      args.length - 1,
      0,
      "--ffmpeg-location",
      path.dirname(ffmpeg.command),
      "--merge-output-format",
      "mp4",
      "--remux-video",
      "mp4"
    );
  }

  try {
    console.error(`[ytdlpgrab] downloading ${videoUrl}`);
    const { stdout } = await runProcess(ytDlp.command, args, {
      cwd: workDir,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      onStderrLine(line) {
        const progress = parseYtDlpProgressLine(line);
        if (progress) {
          emitDownloadProgress(key, progress);
        }
      }
    });
    const downloaded = await findDownloadedFile(workDir, baseName, stdout);

    if (!downloaded) {
      throw new Error("yt-dlp completed but no output file was found.");
    }

    const stat = await fsp.stat(downloaded);
    emitDownloadProgress(key, {
      bytesSoFar: stat.size,
      totalBytes: stat.size
    });

    await fsp.mkdir(CACHE_DIR, { recursive: true });
    try {
      await fsp.rename(downloaded, targetPath);
    } catch (renameError) {
      if (renameError.code === "EXDEV") {
        await fsp.copyFile(downloaded, targetPath);
        await fsp.unlink(downloaded);
      } else {
        throw renameError;
      }
    }
    console.error(`[ytdlpgrab] cached ${targetPath}`);

    try {
      const cacheFiles = await fsp.readdir(CACHE_DIR);
      if (cacheFiles.length > 100) {
        const entries = await Promise.all(
          cacheFiles.map(async (name) => {
            const filePath = path.join(CACHE_DIR, name);
            const stat = await fsp.stat(filePath);
            return { name, filePath, mtimeMs: stat.mtimeMs };
          })
        );
        entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
        const toRemove = entries.slice(0, entries.length - 100);
        await Promise.all(toRemove.map((entry) => removeQuietly(entry.filePath)));
      }
    } catch {
      // Best-effort cleanup only.
    }

    return targetPath;
  } finally {
    await removeQuietly(workDir);
  }
}

function startQueuedDownloads() {
  while (activeDownloads < MAX_ACTIVE_DOWNLOADS && downloadQueue.length > 0) {
    const next = downloadQueue.shift();
    activeDownloads += 1;

    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        activeDownloads -= 1;
        startQueuedDownloads();
      });
  }
}

function runWithDownloadSlot(task) {
  return new Promise((resolve, reject) => {
    downloadQueue.push({ task, resolve, reject });
    startQueuedDownloads();
  });
}

async function ensureDownloaded(videoUrl) {
  const key = cacheKeyFor(videoUrl);
  const targetPath = cachedPathFor(key);

  if (fs.existsSync(targetPath)) {
    return targetPath;
  }

  if (jobs.has(key)) {
    return jobs.get(key);
  }

  const job = runWithDownloadSlot(() => downloadWithYtDlp(videoUrl, key))
    .finally(() => {
      jobs.delete(key);
    });

  jobs.set(key, job);
  return job;
}

async function saveDownloadedCopy(videoUrl, name, destination) {
  const key = cacheKeyFor(videoUrl);
  const outputDirectory = outputDirectoryForDestination(destination);
  await fsp.mkdir(outputDirectory, { recursive: true });
  const targetPath = await uniqueOutputPath(outputDirectory, name);
  const placeholderPath = await createDownloadPlaceholder(targetPath, videoUrl);
  let removeProgressListener = null;
  let lastPlaceholderWrite = 0;
  let pendingPlaceholderWrite = Promise.resolve();

  const updatePlaceholder = (progress, force = false) => {
    const now = Date.now();
    if (!force && now - lastPlaceholderWrite < 750) {
      return;
    }

    lastPlaceholderWrite = now;
    pendingPlaceholderWrite = pendingPlaceholderWrite
      .catch(() => undefined)
      .then(() =>
        writeDownloadPlaceholderInfo(
          placeholderPath,
          targetPath,
          videoUrl,
          progress
        )
      )
      .catch((error) => {
        console.error(
          `[ytdlpgrab] placeholder update failed: ${error.message}`
        );
      });
  };

  removeProgressListener = addDownloadProgressListener(key, (progress) => {
    updatePlaceholder(progress);
  });

  try {
    const sourcePath = await ensureDownloaded(videoUrl);
    const stat = await fsp.stat(sourcePath);
    updatePlaceholder(
      {
        bytesSoFar: stat.size,
        totalBytes: stat.size
      },
      true
    );
    await pendingPlaceholderWrite;
    await fsp.copyFile(sourcePath, targetPath);
    await removeQuietly(placeholderPath);
    console.error(`[ytdlpgrab] saved ${targetPath}`);
    return targetPath;
  } catch (error) {
    await removeQuietly(placeholderPath);
    throw error;
  } finally {
    removeProgressListener?.();
  }
}

function startSave(videoUrl, name, destination) {
  const saveKey = [
    cacheKeyFor(videoUrl),
    destination || "desktop",
    withOutputExtension(name)
  ].join(":");

  if (saveJobs.has(saveKey)) {
    return {
      key: saveKey,
      active: true,
      job: saveJobs.get(saveKey)
    };
  }

  const job = saveDownloadedCopy(videoUrl, name, destination)
    .catch((error) => {
      console.error(`[ytdlpgrab] save failed: ${error.message}`);
      return null;
    })
    .finally(() => {
      saveJobs.delete(saveKey);
    });

  saveJobs.set(saveKey, job);
  return {
    key: saveKey,
    active: true,
    job
  };
}

async function streamDownload(req, res, query) {
  let videoUrl;
  try {
    videoUrl = parseRequestedUrl(query.get("url"));
  } catch (error) {
    sendError(res, 400, error.message);
    return;
  }

  const filename = withOutputExtension(query.get("name") || "youtube-video");
  const modeOption = modeOptionFor(DOWNLOAD_MODE);

  if (!resolveYtDlp()) {
    sendError(
      res,
      503,
      "yt-dlp is not installed.",
      "Run npm run install:yt-dlp or brew install yt-dlp ffmpeg."
    );
    return;
  }

  const download = ensureDownloaded(videoUrl);

  res.writeHead(200, {
    "content-type": modeOption.contentType,
    "content-disposition": contentDisposition(filename),
    "cache-control": "private, max-age=31536000"
  });
  res.flushHeaders();

  try {
    const filePath = await download;
    await pipeline(fs.createReadStream(filePath), res);
  } catch (error) {
    res.destroy(error);
  }
}

async function prepareDownload(res, query) {
  let videoUrl;
  try {
    videoUrl = parseRequestedUrl(query.get("url"));
  } catch (error) {
    sendError(res, 400, error.message);
    return;
  }

  if (!resolveYtDlp()) {
    sendError(
      res,
      503,
      "yt-dlp is not installed.",
      "Run npm run install:yt-dlp or brew install yt-dlp ffmpeg."
    );
    return;
  }

  const key = cacheKeyFor(videoUrl);
  const targetPath = cachedPathFor(key);
  if (!fs.existsSync(targetPath)) {
    ensureDownloaded(videoUrl).catch((error) => {
      console.error(`[ytdlpgrab] prepare failed: ${error.message}`);
    });
  }

  sendJson(res, 202, {
    ok: true,
    cacheKey: key,
    cached: fs.existsSync(targetPath),
    active: jobs.has(key)
  });
}

async function saveDownload(res, query) {
  let videoUrl;
  try {
    videoUrl = parseRequestedUrl(query.get("url"));
  } catch (error) {
    sendError(res, 400, error.message);
    return;
  }

  if (!resolveYtDlp()) {
    sendError(
      res,
      503,
      "yt-dlp is not installed.",
      "Run npm run install:yt-dlp or brew install yt-dlp ffmpeg."
    );
    return;
  }

  const name = query.get("name") || "youtube-video";
  const destination = query.get("destination") || "desktop";
  const { key } = startSave(videoUrl, name, destination);

  sendJson(res, 202, {
    ok: true,
    saveKey: key,
    destination,
    directory: outputDirectoryForDestination(destination),
    active: saveJobs.has(key)
  });
}

function health() {
  const ytDlp = resolveYtDlp();
  const ffmpeg = resolveFfmpeg();
  return {
    ok: true,
    host: HOST,
    port: PORT,
    cacheDir: CACHE_DIR,
    allowAnyUrl: ALLOW_ANY_URL,
    quality: {
      id: QUALITY,
      label: qualityLabelFor(QUALITY),
      options: Array.from(QUALITY_OPTIONS, ([id, option]) => ({
        id,
        label: option.label
      }))
    },
    mode: {
      id: DOWNLOAD_MODE,
      label: modeLabelFor(DOWNLOAD_MODE),
      options: Array.from(DOWNLOAD_MODE_OPTIONS, ([id, option]) => ({
        id,
        label: option.label,
        extension: option.extension
      }))
    },
    jsRuntimes: resolveJavaScriptRuntimes(),
    tools: {
      ytDlp: ytDlp
        ? {
            available: true,
            command: [ytDlp.command, ...ytDlp.args].join(" "),
            version: ytDlp.version
          }
        : {
            available: false,
            install: "npm run install:yt-dlp or brew install yt-dlp ffmpeg"
          },
      ffmpeg: {
        available: Boolean(ffmpeg),
        command: ffmpeg?.command,
        version: ffmpeg?.version
      }
    },
    activeJobs: jobs.size,
    activeDownloads,
    queuedDownloads: downloadQueue.length,
    maxActiveDownloads: MAX_ACTIVE_DOWNLOADS,
    activeSaves: saveJobs.size
  };
}

const server = http.createServer(async (req, res) => {
  try {
    setCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      if (req.headers.origin && !isAllowedExtensionOrigin(req.headers.origin)) {
        sendError(res, 403, "Origin is not allowed.");
        return;
      }

      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, health());
      return;
    }

    if (url.pathname === "/prepare") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, ["POST", "OPTIONS"]);
        return;
      }
      if (!requireTrustedAction(req, res)) {
        return;
      }

      await prepareDownload(res, url.searchParams);
      return;
    }

    if (url.pathname === "/save") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, ["POST", "OPTIONS"]);
        return;
      }
      if (!requireTrustedAction(req, res)) {
        return;
      }

      await saveDownload(res, url.searchParams);
      return;
    }

    if (url.pathname === "/download") {
      if (req.method !== "GET" && req.method !== "POST") {
        sendMethodNotAllowed(res, ["GET", "POST", "OPTIONS"]);
        return;
      }
      if (!requireTrustedAction(req, res)) {
        return;
      }

      await streamDownload(req, res, url.searchParams);
      return;
    }

  sendError(res, 404, "Not found.");
  } catch (error) {
    console.error(`[ytdlpgrab] request error: ${error.message}`);
    if (!res.headersSent) {
      sendError(res, 500, "Internal server error.");
    }
  }
});

server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;

server.listen(PORT, HOST, () => {
  console.error(`[ytdlpgrab] helper listening on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);
});

resolveYtDlp();
resolveFfmpeg();

server.on("error", (error) => {
  console.error(`[ytdlpgrab] server error: ${error.message}`);
});

server.on("clientError", (error, socket) => {
  console.error(`[ytdlpgrab] client error: ${error.message}`);
  socket.destroy(error);
});
