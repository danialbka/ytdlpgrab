const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const extensionRoot = path.join(root, "src", "extension");
const port = Number(process.env.YTDLPGRAB_POPUP_HARNESS_PORT || 8767);

const mockRuntime = `
globalThis.__ytdlpgrabHarness = { messages: [] };
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return {
      ok: true,
      mode: { label: "YouTube Video" },
      tools: { ytDlp: { available: true, version: "2026.fixture" } }
    };
  }
});
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
          callback({
            ok: true,
            video,
            downloadId: 42
          });
        }
      }, 40);
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

  res.writeHead(404);
  res.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`YTDLPGrab popup harness: http://127.0.0.1:${port}/popup.html`);
});
