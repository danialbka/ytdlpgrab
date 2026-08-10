const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "extension", "background.js"),
  "utf8"
);

function loadBackground(activeTab) {
  let messageListener;
  const fetchCalls = [];
  const downloadCalls = [];
  const chrome = {
    runtime: {
      id: "test-extension-id",
      lastError: null,
      getURL(pathname = "") {
        return `chrome-extension://test-extension-id/${pathname.replace(/^\//, "")}`;
      },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} }
    },
    tabs: {
      query(query, callback) {
        assert.equal(query.active, true);
        assert.equal(query.lastFocusedWindow, true);
        assert.deepEqual(Object.keys(query).sort(), [
          "active",
          "lastFocusedWindow"
        ]);
        callback(activeTab ? [activeTab] : []);
      }
    },
    downloads: {
      download(options, callback) {
        downloadCalls.push(options);
        callback(42);
      }
    }
  };

  async function fetch(url, options) {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 202,
      async json() {
        return { ok: true, active: true, destination: "desktop" };
      }
    };
  }

  vm.runInNewContext(backgroundSource, {
    AbortController,
    URL,
    chrome,
    console,
    fetch,
    clearTimeout,
    setTimeout
  });

  function send(message, sender) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("background response timed out")),
        1000
      );
      const asyncResponse = messageListener(message, sender, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      assert.equal(asyncResponse, true);
    });
  }

  return { downloadCalls, fetchCalls, send };
}

const popupSender = {
  id: "test-extension-id",
  url: "chrome-extension://test-extension-id/popup.html"
};

test("reports the currently watched video from the active YouTube tab", async () => {
  const background = loadBackground({
    title: "A useful video - YouTube",
    url: "https://www.youtube.com/watch?v=abc123&t=45"
  });

  const response = await background.send(
    { type: "ytdlpgrab.current-video" },
    popupSender
  );

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    video: {
      name: "A useful video",
      videoUrl: "https://www.youtube.com/watch?v=abc123"
    }
  });
  assert.equal(background.fetchCalls.length, 0);
});

test("opens Chromium Save As for the current video", async () => {
  const background = loadBackground({
    title: "A useful Short - YouTube",
    url: "https://www.youtube.com/shorts/short456?feature=share"
  });

  const response = await background.send(
    { type: "ytdlpgrab.save-current-video" },
    popupSender
  );

  assert.equal(response.ok, true);
  assert.equal(response.video.videoUrl, "https://www.youtube.com/watch?v=short456");
  assert.equal(response.downloadId, 42);
  assert.equal(background.fetchCalls.length, 0);
  assert.equal(background.downloadCalls.length, 1);

  const request = background.downloadCalls[0];
  const helperUrl = new URL(request.url);
  assert.equal(helperUrl.origin, "http://127.0.0.1:17427");
  assert.equal(helperUrl.pathname, "/download");
  assert.equal(helperUrl.searchParams.get("name"), "A useful Short");
  assert.equal(
    helperUrl.searchParams.get("url"),
    "https://www.youtube.com/watch?v=short456"
  );
  assert.equal(request.saveAs, true);
  assert.equal(request.conflictAction, "uniquify");
  assert.deepEqual(JSON.parse(JSON.stringify(request.headers)), [
    { name: "x-ytdlpgrab-extension", value: "1" }
  ]);
});

test("rejects non-video tabs and messages from non-extension pages", async () => {
  const background = loadBackground({
    title: "YouTube",
    url: "https://www.youtube.com/"
  });

  const unsupported = await background.send(
    { type: "ytdlpgrab.current-video" },
    popupSender
  );
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /Open a YouTube video/);

  const untrusted = await background.send(
    { type: "ytdlpgrab.current-video" },
    {
      id: "test-extension-id",
      url: "https://www.youtube.com/watch?v=abc123"
    }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(untrusted)), {
    ok: false,
    error: "Untrusted extension page."
  });
});
