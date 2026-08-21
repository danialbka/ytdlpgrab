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
  const storageData = new Map();
  const badgeCalls = [];
  const alarmsCreated = [];
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
    },
    alarms: {
      onAlarm: { addListener() {} },
      create(name, schedule) {
        alarmsCreated.push({ name, schedule });
      }
    },
    storage: {
      local: {
        async get(key) {
          return storageData.has(key) ? { [key]: storageData.get(key) } : {};
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) {
            storageData.set(key, value);
          }
        }
      }
    },
    action: {
      setBadgeText(options) {
        badgeCalls.push(options.text);
      },
      setBadgeBackgroundColor() {}
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

  return { downloadCalls, fetchCalls, send, storageData, badgeCalls, alarmsCreated };
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

test("prepares the helper download for the current video", async () => {
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
  assert.equal(response.cached, false);
  assert.equal(response.active, true);
  assert.equal(background.downloadCalls.length, 0);
  assert.equal(background.fetchCalls.length, 1);

  const preparedUrl = new URL(background.fetchCalls[0].url);
  assert.equal(preparedUrl.origin, "http://127.0.0.1:17427");
  assert.equal(preparedUrl.pathname, "/prepare");
  assert.equal(preparedUrl.searchParams.get("name"), "A useful Short");
  assert.equal(
    preparedUrl.searchParams.get("url"),
    "https://www.youtube.com/watch?v=short456"
  );
  assert.equal(
    background.fetchCalls[0].options.headers["x-ytdlpgrab-extension"],
    "1"
  );
});

test("opens Chromium Save As on demand with the requested video", async () => {
  const background = loadBackground({
    title: "A useful Short - YouTube",
    url: "https://www.youtube.com/shorts/short456?feature=share"
  });

  const response = await background.send(
    {
      type: "ytdlpgrab.start-browser-download",
      videoUrl: "https://www.youtube.com/watch?v=short456",
      name: "A useful Short"
    },
    popupSender
  );

  assert.equal(response.ok, true);
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

  const rejected = await background.send(
    {
      type: "ytdlpgrab.start-browser-download",
      videoUrl: "https://example.com/watch?v=nope",
      name: "Nope"
    },
    popupSender
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /Invalid or missing video URL/);
  assert.equal(background.downloadCalls.length, 1);
});

test("checks for updates through the helper and stores the result", async () => {
  const background = loadBackground({
    title: "A useful video - YouTube",
    url: "https://www.youtube.com/watch?v=abc123"
  });

  const response = await background.send(
    { type: "ytdlpgrab.update-check" },
    popupSender
  );

  assert.equal(response.ok, true);
  assert.equal(response.update.ok, true);

  const checkUrl = new URL(background.fetchCalls[0].url);
  assert.equal(checkUrl.origin, "http://127.0.0.1:17427");
  assert.equal(checkUrl.pathname, "/update/check");

  const stored = background.storageData.get("updateCheck");
  assert.ok(stored?.checkedAt > 0);
  assert.equal(stored.result.ok, true);

  // An update-available result flips the badge on; a clean result clears it.
  assert.equal(background.badgeCalls.at(-1), "");
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
