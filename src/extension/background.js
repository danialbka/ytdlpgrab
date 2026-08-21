(() => {
  const HELPER_ORIGIN = "http://127.0.0.1:17427";
  const TRUSTED_ACTION_HEADER = "x-ytdlpgrab-extension";
  const TRUSTED_ACTION_VALUE = "1";
  const FETCH_TIMEOUT_MS = 30000;
  const UPDATE_CHECK_ALARM = "ytdlpgrab-update-check";
  const UPDATE_CHECK_PERIOD_MINUTES = 360;
  const UPDATE_STORAGE_KEY = "updateCheck";
  const ALLOWED_PAGE_HOSTS = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be"
  ]);

  function normalizeVideoUrl(rawHref) {
    try {
      const url = new URL(rawHref);
      const host = url.hostname.toLowerCase();

      if (host === "youtu.be") {
        const id = url.pathname.split("/").filter(Boolean)[0];
        return id ? `https://www.youtube.com/watch?v=${id}` : null;
      }

      if (
        host !== "youtube.com" &&
        host !== "www.youtube.com" &&
        host !== "m.youtube.com" &&
        host !== "music.youtube.com"
      ) {
        return null;
      }

      if (url.pathname === "/watch" && url.searchParams.get("v")) {
        return `https://www.youtube.com/watch?v=${url.searchParams.get("v")}`;
      }

      const pathMatch = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/);
      if (pathMatch) {
        return `https://www.youtube.com/watch?v=${pathMatch[1]}`;
      }

      return null;
    } catch {
      return null;
    }
  }

  function isAllowedSender(sender) {
    if (sender.id !== chrome.runtime.id) return false;
    try {
      const senderUrl = new URL(sender.url || sender.tab?.url || "");
      return ALLOWED_PAGE_HOSTS.has(senderUrl.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function isExtensionPageSender(sender) {
    if (sender.id !== chrome.runtime.id || !sender.url) {
      return false;
    }

    try {
      return (
        new URL(sender.url).origin ===
        new URL(chrome.runtime.getURL("/")).origin
      );
    } catch {
      return false;
    }
  }

  function currentActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(tabs?.[0] || null);
      });
    });
  }

  async function currentVideo() {
    const tab = await currentActiveTab();
    const videoUrl = normalizeVideoUrl(tab?.url);
    if (!videoUrl) {
      throw new Error("Open a YouTube video, Short, or live stream first.");
    }

    const name = String(tab.title || "youtube-video")
      .replace(/\s+-\s+YouTube\s*$/i, "")
      .trim() || "youtube-video";

    return { videoUrl, name };
  }

  function helperUrl(pathname, videoUrl, name, destination) {
    const url = new URL(pathname, HELPER_ORIGIN);
    url.searchParams.set("url", videoUrl);
    url.searchParams.set("name", String(name || "youtube-video"));
    if (destination) {
      url.searchParams.set("destination", destination);
    }
    return url.toString();
  }

  async function postHelper(pathname, videoUrl, name, destination) {
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(helperUrl(pathname, videoUrl, name, destination), {
        method: "POST",
        headers: {
          [TRUSTED_ACTION_HEADER]: TRUSTED_ACTION_VALUE
        },
        signal: ac.signal
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        throw new Error(body.error || `Helper returned ${response.status}.`);
      }

      return body;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function startBrowserDownload(video) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: helperUrl("/download", video.videoUrl, video.name),
          saveAs: true,
          conflictAction: "uniquify",
          headers: [
            {
              name: TRUSTED_ACTION_HEADER,
              value: TRUSTED_ACTION_VALUE
            }
          ]
        },
        (downloadId) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }

          if (!Number.isInteger(downloadId)) {
            reject(new Error("Chromium did not start the download."));
            return;
          }

          resolve(downloadId);
        }
      );
    });
  }

  async function prepareHelperDownload(video) {
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(helperUrl("/prepare", video.videoUrl, video.name), {
        method: "POST",
        headers: {
          [TRUSTED_ACTION_HEADER]: TRUSTED_ACTION_VALUE
        },
        signal: ac.signal
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        throw new Error(body.error || `Helper returned ${response.status}.`);
      }

      return body;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function applyUpdateBadge(updateAvailable) {
    try {
      chrome.action.setBadgeText({ text: updateAvailable ? "!" : "" });
      chrome.action.setBadgeBackgroundColor({ color: "#ff0033" });
    } catch {
      // Badge is cosmetic; ignore unsupported action API states.
    }
  }

  async function checkForUpdates() {
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), 10000);
    let result;
    try {
      const response = await fetch(new URL("/update/check", HELPER_ORIGIN), {
        signal: ac.signal
      });
      result = await response.json().catch(() => null);
    } catch (error) {
      result = { ok: false, error: error.message };
    } finally {
      clearTimeout(timeoutId);
    }

    if (result) {
      await chrome.storage.local.set({
        [UPDATE_STORAGE_KEY]: { checkedAt: Date.now(), result }
      });
      applyUpdateBadge(result.ok === true && result.updateAvailable === true);
    }

    return result;
  }

  async function storedUpdateCheck() {
    const stored = await chrome.storage.local.get(UPDATE_STORAGE_KEY);
    return stored?.[UPDATE_STORAGE_KEY]?.result || null;
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_CHECK_ALARM) {
      checkForUpdates();
    }
  });

  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(UPDATE_CHECK_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES
    });
    checkForUpdates();
  });

  chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create(UPDATE_CHECK_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES
    });
    checkForUpdates();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (
      message.type === "ytdlpgrab.current-video" ||
      message.type === "ytdlpgrab.save-current-video"
    ) {
      if (!isExtensionPageSender(sender)) {
        sendResponse({ ok: false, error: "Untrusted extension page." });
        return false;
      }

      currentVideo()
        .then(async (video) => {
          if (message.type === "ytdlpgrab.current-video") {
            return { ok: true, video };
          }

          const prepare = await prepareHelperDownload(video);
          return {
            ok: true,
            video,
            cached: Boolean(prepare.cached),
            active: Boolean(prepare.active)
          };
        })
        .then((response) => {
          try {
            sendResponse(response);
          } catch {}
        })
        .catch((error) => {
          try {
            sendResponse({ ok: false, error: error.message });
          } catch {}
        });

      return true;
    }

    if (message.type === "ytdlpgrab.start-browser-download") {
      if (!isExtensionPageSender(sender)) {
        sendResponse({ ok: false, error: "Untrusted extension page." });
        return false;
      }

      const videoUrl = normalizeVideoUrl(message.videoUrl);
      if (!videoUrl) {
        sendResponse({ ok: false, error: "Invalid or missing video URL in message." });
        return false;
      }

      const name = String(message.name || "youtube-video").slice(0, 300);
      startBrowserDownload({ videoUrl, name })
        .then((downloadId) => {
          try {
            sendResponse({ ok: true, downloadId });
          } catch {}
        })
        .catch((error) => {
          try {
            sendResponse({ ok: false, error: error.message });
          } catch {}
        });

      return true;
    }

    if (message.type === "ytdlpgrab.update-check") {
      if (!isExtensionPageSender(sender)) {
        sendResponse({ ok: false, error: "Untrusted extension page." });
        return false;
      }

      checkForUpdates()
        .then((result) => {
          try {
            sendResponse({ ok: true, update: result });
          } catch {}
        });
      return true;
    }

    if (message.type !== "ytdlpgrab.save") {
      return false;
    }

    if (!isAllowedSender(sender)) {
      sendResponse({ ok: false, error: "Untrusted sender: not a YouTube page." });
      return false;
    }

    const videoUrl = normalizeVideoUrl(message.videoUrl);
    if (!videoUrl) {
      sendResponse({ ok: false, error: "Invalid or missing video URL in message." });
      return false;
    }

    postHelper(
      "/save",
      videoUrl,
      message.name,
      message.destination || "desktop"
    )
      .then((body) => { try { sendResponse({ ok: true, body }); } catch {} })
      .catch((error) => { try { sendResponse({ ok: false, error: error.message }); } catch {} });

    return true;
  });
})();
