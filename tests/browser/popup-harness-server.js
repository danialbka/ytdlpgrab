const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const extensionRoot = path.join(root, "src", "extension");
const port = Number(process.env.YTDLPGRAB_POPUP_HARNESS_PORT || 8767);

const mockRuntime = `
globalThis.__ytdlpgrabHarness = { messages: [], downloadItem: null };
const listeners = [];
let progressStep = 0;

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    }
  };
}

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes("/progress")) {
    progressStep += 1;
    if (progressStep <= 3) {
      return jsonResponse({
        ok: true,
        cacheKey: "fixture-key",
        cached: false,
        active: true,
        percent: progressStep * 25,
        bytesSoFar: progressStep * 2500000,
        totalBytes: 10000000
      });
    }
    return jsonResponse({
      ok: true,
      cacheKey: "fixture-key",
      cached: true,
      active: false,
      percent: 100,
      bytesSoFar: 10000000,
      totalBytes: 10000000
    });
  }
  return jsonResponse({
    ok: true,
    mode: { label: "YouTube Video" },
    tools: { ytDlp: { available: true, version: "2026.fixture" } }
  });
};

function emitChanged(delta) {
  for (const listener of [...listeners]) {
    listener(delta);
  }
}

function simulateBrowserDownload() {
  const item = {
    id: 42,
    state: "in_progress",
    bytesReceived: 0,
    totalBytes: 10000000
  };
  globalThis.__ytdlpgrabHarness.downloadItem = item;

  [1500000, 4200000, 7300000, 9100000].forEach((bytes, index) => {
    setTimeout(() => {
      item.bytesReceived = bytes;
      emitChanged({ id: 42 });
    }, 350 * (index + 1));
  });

  setTimeout(() => {
    item.state = "complete";
    item.bytesReceived = 10000000;
    emitChanged({ id: 42, state: { current: "complete" } });
  }, 1900);
}

globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage(message, callback) {
      globalThis.__ytdlpgrabHarness.messages.push(message.type);
      const video = {
        name: "Chromium developer test video",
        videoUrl: "https://www.youtube.com/watch?v=fixture123"
      };
      setTimeout(() => {
        if (message.type === "ytdlpgrab.current-video") {
          callback({ ok: true, video });
          return;
        }
        if (message.type === "ytdlpgrab.save-current-video") {
          callback({ ok: true, video, cached: false, active: true });
          return;
        }
        if (message.type === "ytdlpgrab.update-check") {
          callback({
            ok: true,
            update: {
              ok: true,
              current: "0.1.7",
              latest: "0.1.8",
              updateAvailable: true,
              releaseUrl:
                "https://github.com/danialbka/ytdlpgrab/releases/latest"
            }
          });
          return;
        }
        if (message.type === "ytdlpgrab.start-browser-download") {
          callback({ ok: true, downloadId: 42 });
          simulateBrowserDownload();
        }
      }, 40);
    }
  },
  downloads: {
    onChanged: {
      addListener(listener) {
        listeners.push(listener);
      },
      hasListener(listener) {
        return listeners.includes(listener);
      }
    },
    search(query, callback) {
      const item = globalThis.__ytdlpgrabHarness.downloadItem;
      setTimeout(() => {
        callback(!query.id || query.id === item?.id ? (item ? [item] : []) : []);
      }, 10);
    }
  }
};
`;

function send(res, status, contentType, body) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/popup.html") {
    const html = fs
      .readFileSync(path.join(extensionRoot, "popup.html"), "utf8")
      .replace(
        '<script src="popup.js"></script>',
        '<script src="/mock-runtime.js"></script><script src="/popup.js"></script>'
      );
    send(res, 200, "text/html; charset=utf-8", html);
    return;
  }

  if (req.url === "/mock-runtime.js") {
    send(res, 200, "text/javascript; charset=utf-8", mockRuntime);
    return;
  }

  if (req.url === "/popup.js") {
    send(
      res,
      200,
      "text/javascript; charset=utf-8",
      fs.readFileSync(path.join(extensionRoot, "popup.js"))
    );
    return;
  }

  if (req.url === "/popup.css") {
    send(
      res,
      200,
      "text/css; charset=utf-8",
      fs.readFileSync(path.join(extensionRoot, "popup.css"))
    );
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`YTDLPGrab popup harness: http://127.0.0.1:${port}/popup.html`);
});
