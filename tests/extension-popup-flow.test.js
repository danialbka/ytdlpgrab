const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const popupSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "extension", "popup.js"),
  "utf8"
);

const VIDEO_URL = "https://www.youtube.com/watch?v=fixture123";

class FakeElement {
  constructor(id) {
    this.id = id;
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classListSet = new Set();
    this.classList = {
      add: (...names) => {
        for (const name of names) this.classListSet.add(name);
      },
      remove: (...names) => {
        for (const name of names) this.classListSet.delete(name);
      },
      contains: (name) => this.classListSet.has(name)
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  click() {
    const listener = this.listeners.get("click");
    if (listener) {
      listener();
    }
  }
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for: ${message}`);
}

function loadPopup({ initialDownloadItem = null } = {}) {
  const elementIds = [
    "dot",
    "status",
    "detail",
    "download-current",
    "current-detail",
    "action-status",
    "download-progress",
    "progress-bar",
    "progress-fill",
    "progress-label",
    "update-banner",
    "update-banner-label"
  ];
  const elements = {};
  for (const id of elementIds) {
    elements[id] = new FakeElement(id);
  }

  const sentMessages = [];
  const downloadListeners = [];
  let downloadItem = initialDownloadItem;
  let progressCalls = 0;

  function emitChanged(delta) {
    for (const listener of [...downloadListeners]) {
      listener(delta);
    }
  }

  function simulateBrowserDownload() {
    downloadItem = {
      id: 42,
      state: "in_progress",
      bytesReceived: 0,
      totalBytes: 10000000
    };

    [2500000, 6000000, 9000000].forEach((bytes, index) => {
      setTimeout(() => {
        downloadItem.bytesReceived = bytes;
        emitChanged({ id: 42 });
      }, 120 * (index + 1));
    });

    setTimeout(() => {
      downloadItem.state = "complete";
      downloadItem.bytesReceived = 10000000;
      emitChanged({ id: 42, state: { current: "complete" } });
    }, 700);
  }

  const video = { name: "Fixture video", videoUrl: VIDEO_URL };

  const chromeStub = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        sentMessages.push(message.type);
        setTimeout(() => {
          if (message.type === "ytdlpgrab.current-video") {
            callback({ ok: true, video });
            return;
          }
          if (message.type === "ytdlpgrab.save-current-video") {
            callback({ ok: true, video, cached: false, active: true });
            return;
          }
          if (message.type === "ytdlpgrab.start-browser-download") {
            callback({ ok: true, downloadId: 42 });
            simulateBrowserDownload();
          }
        }, 25);
      }
    },
    downloads: {
      onChanged: {
        addListener(listener) {
          downloadListeners.push(listener);
        },
        hasListener(listener) {
          return downloadListeners.includes(listener);
        }
      },
      search(query, callback) {
        setTimeout(() => {
          const matches =
            downloadItem && (!query.id || query.id === downloadItem.id)
              ? [downloadItem]
              : [];
          callback(matches);
        }, 5);
      }
    }
  };

  async function fetch(url) {
    const target = String(url);
    if (target.includes("/progress")) {
      progressCalls += 1;
      // The first call is the resume-on-open check and must be idle.
      if (progressCalls === 1) {
        return jsonResponse({
          ok: true,
          cacheKey: "k",
          cached: false,
          active: false,
          percent: null,
          bytesSoFar: 0,
          totalBytes: 0
        });
      }
      if (progressCalls <= 3) {
        return jsonResponse({
          ok: true,
          cacheKey: "k",
          cached: false,
          active: true,
          percent: progressCalls * 30,
          bytesSoFar: progressCalls * 3000000,
          totalBytes: 10000000
        });
      }
      return jsonResponse({
        ok: true,
        cacheKey: "k",
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
  }

  vm.runInNewContext(popupSource, {
    AbortController,
    URL,
    chrome: chromeStub,
    console,
    document: { getElementById: (id) => elements[id] || null },
    fetch,
    clearTimeout,
    setTimeout
  });

  return {
    elements,
    sentMessages,
    emitChanged,
    setDownloadItem(item) {
      downloadItem = item;
    }
  };
}

test("popup shows preparing state then a Chrome download progress bar", async () => {
  const popup = loadPopup();
  const { elements, sentMessages } = popup;
  const button = elements["download-current"];
  const fill = elements["progress-fill"];
  const bar = elements["progress-bar"];
  const label = elements["progress-label"];

  await waitFor(
    () =>
      !button.disabled &&
      button.textContent === "Download current video" &&
      sentMessages.includes("ytdlpgrab.current-video"),
    "popup to become ready"
  );
  assert.equal(elements["current-detail"].textContent, "Fixture video");
  assert.deepEqual(
    sentMessages.filter((type) => type !== "ytdlpgrab.update-check"),
    ["ytdlpgrab.current-video"]
  );

  button.click();

  await waitFor(
    () => sentMessages.includes("ytdlpgrab.save-current-video"),
    "save request to be sent"
  );

  await waitFor(
    () => /^Preparing… \d+%$/.test(button.textContent),
    "button to show preparing percentage"
  );
  assert.ok(button.disabled, "button is disabled while preparing");

  await waitFor(
    () => sentMessages.includes("ytdlpgrab.start-browser-download"),
    "browser download request after caching"
  );

  await waitFor(
    () => Number(bar.attributes.get("aria-valuenow")) > 0,
    "Chrome download percentage to advance"
  );
  assert.match(button.textContent, /^Downloading… \d+%$/);
  assert.equal(bar.classListSet.has("indeterminate"), false);

  await waitFor(
    () => label.textContent.includes("Download complete"),
    "progress completion label"
  );
  assert.equal(fill.style.width, "100%");
  assert.ok(elements["action-status"].className.includes("success"));
  assert.match(label.textContent, /10\.0 MB/);

  await waitFor(
    () => !button.disabled && button.textContent === "Download current video",
    "button to become reusable after completion"
  );
});

test("popup resumes an in-progress Chrome download when reopened", async () => {
  const popup = loadPopup({
    initialDownloadItem: {
      id: 7,
      state: "in_progress",
      bytesReceived: 4000000,
      totalBytes: 10000000,
      url: `http://127.0.0.1:17427/download?url=${encodeURIComponent(VIDEO_URL)}&name=x`
    }
  });
  const { elements } = popup;
  const button = elements["download-current"];
  const fill = elements["progress-fill"];
  const label = elements["progress-label"];

  await waitFor(
    () => /^Downloading… \d+%$/.test(button.textContent),
    "reopened popup to resume showing the active download"
  );
  assert.ok(button.disabled, "button is disabled while a download runs");
  assert.equal(fill.style.width, "40%");
  assert.match(label.textContent, /4\.0 MB of 10\.0 MB/);

  popup.setDownloadItem({
    id: 7,
    state: "complete",
    bytesReceived: 10000000,
    totalBytes: 10000000
  });
  popup.emitChanged({ id: 7, state: { current: "complete" } });

  await waitFor(
    () => label.textContent.includes("Download complete"),
    "resumed download to complete"
  );
});
