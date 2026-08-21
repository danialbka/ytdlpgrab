const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const serverPath = path.join(
  __dirname,
  "..",
  "src",
  "server",
  "index.js"
);

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function startFixtureServer(fixtureOverrides = {}) {
  const fixtureRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "ytdlpgrab-helper-test-")
  );
  const fakeYtDlp = path.join(fixtureRoot, "fake-yt-dlp");
  const invocationLog = path.join(fixtureRoot, "yt-dlp-invocations.jsonl");
  const cacheDir = path.join(fixtureRoot, "cache");
  const desktopDir = path.join(fixtureRoot, "Desktop");
  const port = await unusedPort();

  await fsp.writeFile(
    fakeYtDlp,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");

fs.appendFileSync(
  process.env.FIXTURE_INVOCATION_LOG,
  JSON.stringify(process.argv.slice(2)) + "\\n"
);

if (process.argv.includes("--version")) {
  console.log("2026.fixture");
  process.exit(0);
}
if (process.argv.includes("--help")) {
  setTimeout(() => {
    console.log("fixture downloader --js-runtimes RUNTIME[:PATH]");
  }, Number(process.env.FIXTURE_HELP_DELAY_MS || 0));
} else {
  const outputIndex = process.argv.indexOf("-o");
  const outputTemplate = process.argv[outputIndex + 1];
  const outputPath = outputTemplate.replace("%(ext)s", "mp4");
  setTimeout(() => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "fixture-video");
    process.stderr.write("[download] 100.0% of 13 B\\n");
    process.stdout.write(outputPath + "\\n");
  }, 600);
}
`,
    { mode: 0o755 }
  );
  await fsp.mkdir(desktopDir, { recursive: true });

  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      HOME: fixtureRoot,
      FIXTURE_HELP_DELAY_MS: "3200",
      FIXTURE_INVOCATION_LOG: invocationLog,
      YT_DLP_PATH: fakeYtDlp,
      YTDLPGRAB_CACHE_DIR: cacheDir,
      YTDLPGRAB_PORT: String(port),
      YTDLPGRAB_TOOL_CACHE_TTL_MS: "100",
      ...fixtureOverrides.env
    },
    stdio: ["ignore", "ignore", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`helper exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, `helper did not start: ${stderr}`);

  return {
    cacheDir,
    child,
    desktopDir,
    fixtureRoot,
    invocationLog,
    origin,
    stderr: () => stderr
  };
}

async function stopFixtureServer(fixture) {
  if (fixture.child.exitCode === null) {
    fixture.child.kill("SIGTERM");
    await new Promise((resolve) => {
      fixture.child.once("close", resolve);
      setTimeout(resolve, 1000);
    });
  }
  await fsp.rm(fixture.fixtureRoot, { force: true, recursive: true });
}

test("helper validates requests and queues one current-video save", async () => {
  const fixture = await startFixtureServer();
  try {
    const healthResponse = await fetch(`${fixture.origin}/health`);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(health.port, Number(new URL(fixture.origin).port));
    assert.equal(health.tools.ytDlp.available, true);
    assert.equal(health.tools.ytDlp.version, "2026.fixture");

    const videoUrl = "https://www.youtube.com/watch?v=fixture123";
    const saveUrl = new URL("/save", fixture.origin);
    saveUrl.searchParams.set("url", videoUrl);
    saveUrl.searchParams.set("name", "Café fixture");
    saveUrl.searchParams.set("destination", "desktop");

    const rejected = await fetch(saveUrl, { method: "POST" });
    assert.equal(rejected.status, 403);

    const headers = { "x-ytdlpgrab-extension": "1" };
    const prepareUrl = new URL("/prepare", fixture.origin);
    prepareUrl.searchParams.set("url", videoUrl);
    const prepareStartedAt = Date.now();
    const prepared = await fetch(prepareUrl, { method: "POST", headers });
    assert.equal(prepared.status, 202);
    assert.ok(
      Date.now() - prepareStartedAt < 500,
      "prepare should queue work instead of waiting for the download"
    );

    const [firstSave, duplicateSave] = await Promise.all([
      fetch(saveUrl, { method: "POST", headers }),
      fetch(saveUrl, { method: "POST", headers })
    ]);
    assert.equal(firstSave.status, 202);
    assert.equal(duplicateSave.status, 202);

    const savedFiles = await waitFor(async () => {
      const files = await fsp.readdir(fixture.desktopDir);
      return files.includes("Café fixture.mp4") ? files : null;
    }, `Desktop save did not finish: ${fixture.stderr()}`, 15000);

    assert.deepEqual(savedFiles, ["Café fixture.mp4"]);
    assert.equal(
      await fsp.readFile(
        path.join(fixture.desktopDir, "Café fixture.mp4"),
        "utf8"
      ),
      "fixture-video"
    );

    const invocations = (await fsp.readFile(fixture.invocationLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const downloadInvocation = invocations.find((args) => args.includes("-o"));
    assert.ok(downloadInvocation, "fixture yt-dlp download was not invoked");
    const jsRuntimeIndex = downloadInvocation.indexOf("--js-runtimes");
    assert.ok(
      jsRuntimeIndex >= 0,
      "a slow yt-dlp capability check must still enable JavaScript runtimes"
    );
    assert.match(downloadInvocation[jsRuntimeIndex + 1], /^(node|bun):/);

    const downloadUrl = new URL("/download", fixture.origin);
    downloadUrl.searchParams.set("url", videoUrl);
    downloadUrl.searchParams.set("name", "Café fixture");
    const downloaded = await fetch(downloadUrl, { headers });
    assert.equal(downloaded.status, 200);
    assert.match(
      downloaded.headers.get("content-disposition"),
      /filename="Caf_ fixture\.mp4"; filename\*=UTF-8''Caf%C3%A9%20fixture\.mp4/
    );
    assert.equal(await downloaded.text(), "fixture-video");

    const uncachedUrl = new URL("/download", fixture.origin);
    uncachedUrl.searchParams.set(
      "url",
      "https://www.youtube.com/watch?v=pickerFixture456"
    );
    uncachedUrl.searchParams.set("name", "Picker fixture");
    const responseStartedAt = Date.now();
    const uncachedDownload = await fetch(uncachedUrl, { headers });
    assert.equal(uncachedDownload.status, 200);
    assert.ok(
      Date.now() - responseStartedAt < 500,
      "download headers should arrive before media preparation finishes"
    );
    assert.equal(await uncachedDownload.text(), "fixture-video");
  } finally {
    await stopFixtureServer(fixture);
  }
});

test("reports download progress and serves cached files with a known length", async () => {
  const fixture = await startFixtureServer();
  try {
    const headers = { "x-ytdlpgrab-extension": "1" };
    const videoUrl = "https://www.youtube.com/watch?v=progressFixture789";

    const progressUrl = new URL("/progress", fixture.origin);
    progressUrl.searchParams.set("url", videoUrl);

    const idle = await (await fetch(progressUrl)).json();
    assert.equal(idle.ok, true);
    assert.equal(idle.cached, false);
    assert.equal(idle.active, false);

    const prepareUrl = new URL("/prepare", fixture.origin);
    prepareUrl.searchParams.set("url", videoUrl);
    const prepared = await fetch(prepareUrl, { method: "POST", headers });
    assert.equal(prepared.status, 202);

    const active = await (await fetch(progressUrl)).json();
    assert.equal(active.ok, true);
    assert.equal(active.cached, false);
    assert.equal(active.active, true);

    const done = await waitFor(async () => {
      const progress = await (await fetch(progressUrl)).json();
      return progress.cached ? progress : null;
    }, "download never reported cached", 15000);

    assert.equal(done.percent, 100);
    assert.equal(done.totalBytes, 13);
    assert.equal(done.bytesSoFar, 13);

    const downloadUrl = new URL("/download", fixture.origin);
    downloadUrl.searchParams.set("url", videoUrl);
    const downloaded = await fetch(downloadUrl, { headers });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-length"), "13");
    assert.equal(await downloaded.text(), "fixture-video");
  } finally {
    await stopFixtureServer(fixture);
  }
});

test("update check compares the running version against GitHub releases", async () => {
  const releasePayload = {
    tag_name: "v9.9.9",
    html_url: "https://github.com/danialbka/ytdlpgrab/releases/tag/v9.9.9",
    published_at: "2026-01-01T00:00:00Z",
    assets: [
      {
        name: "YTDLPGrab-9.9.9-arm64.dmg",
        browser_download_url: "https://example.com/YTDLPGrab-9.9.9-arm64.dmg"
      },
      {
        name: "ytdlpgrab-extension-9.9.9.zip",
        browser_download_url: "https://example.com/ytdlpgrab-extension-9.9.9.zip"
      }
    ]
  };

  const github = http.createServer((req, res) => {
    if (req.url === "/repos/danialbka/ytdlpgrab/releases/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(releasePayload));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => github.listen(0, "127.0.0.1", resolve));
  const githubPort = github.address().port;

  try {
    const outdated = await startFixtureServer({
      env: {
        YTDLPGRAB_VERSION: "0.1.6",
        YTDLPGRAB_GITHUB_API: `http://127.0.0.1:${githubPort}`
      }
    });
    try {
      const response = await fetch(
        `${outdated.origin}/update/check`
      );
      const update = await response.json();
      assert.equal(update.ok, true);
      assert.equal(update.current, "0.1.6");
      assert.equal(update.latest, "9.9.9");
      assert.equal(update.updateAvailable, true);
      assert.equal(update.releaseUrl, releasePayload.html_url);
      assert.equal(update.assets.dmg, "https://example.com/YTDLPGrab-9.9.9-arm64.dmg");
      assert.equal(
        update.assets.extensionZip,
        "https://example.com/ytdlpgrab-extension-9.9.9.zip"
      );
    } finally {
      await stopFixtureServer(outdated);
    }

    const current = await startFixtureServer({
      env: {
        YTDLPGRAB_VERSION: "9.9.9",
        YTDLPGRAB_GITHUB_API: `http://127.0.0.1:${githubPort}`
      }
    });
    try {
      const response = await fetch(`${current.origin}/update/check`);
      const update = await response.json();
      assert.equal(update.ok, true);
      assert.equal(update.updateAvailable, false);
      assert.equal(update.assets, null);
    } finally {
      await stopFixtureServer(current);
    }
  } finally {
    await new Promise((resolve) => github.close(resolve));
  }
});
