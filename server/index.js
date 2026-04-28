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
const BUNDLED_PYTHON_DIR = path.join(PROJECT_ROOT, "python");
const HOST = process.env.YTDLPGRAB_HOST || "127.0.0.1";
const PORT = Number(process.env.YTDLPGRAB_PORT || process.env.PORT || 17427);
const CACHE_DIR =
  process.env.YTDLPGRAB_CACHE_DIR ||
  path.join(os.homedir(), "Library", "Caches", "ytdlpgrab");
const ALLOW_ANY_URL = process.env.YTDLPGRAB_ALLOW_ANY_URL === "1";
const DOWNLOAD_TIMEOUT_MS = Number(
  process.env.YTDLPGRAB_TIMEOUT_MS || 60 * 60 * 1000
);
const TOOL_CHECK_TIMEOUT_MS = Number(
  process.env.YTDLPGRAB_TOOL_CHECK_TIMEOUT_MS || 3000
);
const TOOL_CACHE_TTL_MS = Number(
  process.env.YTDLPGRAB_TOOL_CACHE_TTL_MS || 30 * 1000
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
const QUALITY = qualityFromValue(process.env.YTDLPGRAB_QUALITY);

const jobs = new Map();
const saveJobs = new Map();
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

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
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
    .trim()
    .slice(0, 120);

  return cleaned || "youtube-video";
}

function withMp4Extension(name) {
  const base = sanitizeFileName(name).replace(/\.[a-z0-9]{1,5}$/i, "");
  return `${base}.mp4`;
}

function contentDisposition(filename) {
  const asciiName = withMp4Extension(filename).replace(/[";]/g, " ");
  return `attachment; filename="${asciiName}"`;
}

function outputDirectoryForDestination(destination) {
  const normalized = String(destination || "desktop").toLowerCase();

  if (normalized === "downloads") {
    return path.join(os.homedir(), "Downloads");
  }

  return path.join(os.homedir(), "Desktop");
}

function parseRequestedUrl(value) {
  if (!value || value.length > 4096) {
    throw new Error("Missing or oversized url parameter.");
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
  const normalized = String(value || "best").toLowerCase().replace(/p$/, "");
  return QUALITY_OPTIONS.has(normalized) ? normalized : "best";
}

function qualityLabelFor(quality) {
  return QUALITY_OPTIONS.get(quality)?.label || QUALITY_OPTIONS.get("best").label;
}

function formatSelectorForQuality(quality) {
  const option = QUALITY_OPTIONS.get(quality) || QUALITY_OPTIONS.get("best");
  if (!option.height) {
    return "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b";
  }

  const height = option.height;
  return [
    `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
    `bv*[height<=${height}]+ba`,
    `b[height<=${height}][ext=mp4]`,
    `b[height<=${height}]`,
    `best[height<=${height}]`,
    "best"
  ].join("/");
}

function cacheKeyFor(videoUrl) {
  return crypto
    .createHash("sha256")
    .update(`${videoUrl}\nquality=${QUALITY}`)
    .digest("hex");
}

function cachedPathFor(key) {
  return path.join(CACHE_DIR, `${key}.mp4`);
}

function cacheGet(key, resolver) {
  const entry = toolCache[key];
  const now = Date.now();

  if (entry.value !== undefined && now - entry.checkedAt < TOOL_CACHE_TTL_MS) {
    return entry.value;
  }

  entry.checkedAt = now;
  entry.value = resolver();
  return entry.value;
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

    const localPython = path.join(PROJECT_ROOT, ".venv", "bin", "python");
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
    return String(result.stdout || result.stderr).trim().split(/\s+/)[2] || true;
  }

  return null;
}

function resolveFfmpeg() {
  return cacheGet("ffmpeg", () => resolveBinary("ffmpeg"));
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
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node"
    ]);
    const bunPath = resolveRuntimePath("bun", [
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
      timeout: TOOL_CHECK_TIMEOUT_MS
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
  const printedPath = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => path.isAbsolute(line))
    .pop();

  if (printedPath && fs.existsSync(printedPath)) {
    return printedPath;
  }

  const entries = await fsp.readdir(workDir);
  const candidates = entries
    .filter((entry) => entry.startsWith(baseName))
    .filter((entry) => !entry.endsWith(".part") && !entry.endsWith(".ytdl"))
    .map((entry) => path.join(workDir, entry));

  const mp4 = candidates.find((entry) => entry.toLowerCase().endsWith(".mp4"));
  return mp4 || candidates[0];
}

async function removeQuietly(filePath) {
  try {
    await fsp.rm(filePath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

async function uniqueOutputPath(directory, filename) {
  const safeName = withMp4Extension(filename);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);

  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : ` ${index + 1}`;
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

async function createDownloadPlaceholder(targetPath, videoUrl) {
  const placeholderPath = `${targetPath}.download`;
  await fsp.mkdir(placeholderPath);
  const info = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>DownloadEntryPath</key>',
    `  <string>${escapePlistString(targetPath)}</string>`,
    '  <key>DownloadEntryURL</key>',
    `  <string>${escapePlistString(videoUrl)}</string>`,
    '  <key>DownloadEntryProgressBytesSoFar</key>',
    '  <integer>0</integer>',
    '  <key>DownloadEntryProgressTotalToLoad</key>',
    '  <integer>0</integer>',
    '</dict>',
    '</plist>',
    ''
  ].join("\n");

  await fsp.writeFile(path.join(placeholderPath, "Info.plist"), info);
  return placeholderPath;
}

function escapePlistString(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

  const args = [
    ...ytDlp.args,
    ...ytDlpJavaScriptArgs(ytDlp),
    "--no-playlist",
    "--no-mtime",
    "--newline",
    "-f",
    formatSelectorForQuality(QUALITY),
    "--merge-output-format",
    "mp4",
    "--remux-video",
    "mp4",
    "--print",
    "after_move:filepath",
    "-o",
    outputTemplate,
    videoUrl
  ];

  try {
    console.error(`[ytdlpgrab] downloading ${videoUrl}`);
    const { stdout } = await runProcess(ytDlp.command, args, {
      cwd: workDir,
      timeoutMs: DOWNLOAD_TIMEOUT_MS
    });
    const downloaded = await findDownloadedFile(workDir, baseName, stdout);

    if (!downloaded) {
      throw new Error("yt-dlp completed but no output file was found.");
    }

    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.rename(downloaded, targetPath);
    console.error(`[ytdlpgrab] cached ${targetPath}`);
    return targetPath;
  } finally {
    await removeQuietly(workDir);
  }
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

  const job = downloadWithYtDlp(videoUrl, key).finally(() => {
    jobs.delete(key);
  });

  jobs.set(key, job);
  return job;
}

async function saveDownloadedCopy(videoUrl, name, destination) {
  const outputDirectory = outputDirectoryForDestination(destination);
  await fsp.mkdir(outputDirectory, { recursive: true });
  const targetPath = await uniqueOutputPath(outputDirectory, name);
  const placeholderPath = await createDownloadPlaceholder(targetPath, videoUrl);

  try {
    const sourcePath = await ensureDownloaded(videoUrl);
    await fsp.copyFile(sourcePath, targetPath);
    await removeQuietly(placeholderPath);
    console.error(`[ytdlpgrab] saved ${targetPath}`);
    return targetPath;
  } catch (error) {
    await removeQuietly(placeholderPath);
    throw error;
  }
}

function startSave(videoUrl, name, destination) {
  const saveKey = [
    cacheKeyFor(videoUrl),
    destination || "desktop",
    withMp4Extension(name)
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

  const filename = withMp4Extension(query.get("name") || "youtube-video");

  try {
    const filePath = await ensureDownloaded(videoUrl);
    const stat = await fsp.stat(filePath);

    res.writeHead(200, {
      "access-control-allow-origin": "*",
      "content-type": "video/mp4",
      "content-disposition": contentDisposition(filename),
      "content-length": stat.size,
      "cache-control": "private, max-age=31536000"
    });

    await pipeline(fs.createReadStream(filePath), res);
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, 500, "Download failed.", error.message);
    } else {
      res.destroy(error);
    }
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
        version: ffmpeg || undefined
      }
    },
    activeJobs: jobs.size,
    activeSaves: saveJobs.size
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, health());
    return;
  }

  if (req.method === "GET" && url.pathname === "/prepare") {
    await prepareDownload(res, url.searchParams);
    return;
  }

  if (req.method === "GET" && url.pathname === "/save") {
    await saveDownload(res, url.searchParams);
    return;
  }

  if (req.method === "GET" && url.pathname === "/download") {
    await streamDownload(req, res, url.searchParams);
    return;
  }

  sendError(res, 404, "Not found.");
});

server.listen(PORT, HOST, () => {
  console.error(`[ytdlpgrab] helper listening on http://${HOST}:${PORT}`);
});
