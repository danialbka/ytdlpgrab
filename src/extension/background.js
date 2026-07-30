(() => {
  const HELPER_ORIGIN = "http://127.0.0.1:17427";
  const TRUSTED_ACTION_HEADER = "x-ytdlpgrab-extension";
  const TRUSTED_ACTION_VALUE = "1";
  const FETCH_TIMEOUT_MS = 30000;
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

          const body = await postHelper(
            "/save",
            video.videoUrl,
            video.name,
            "desktop"
          );
          return { ok: true, video, body };
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

  chrome.runtime.onInstalled.addListener(() => {});
  chrome.runtime.onStartup.addListener(() => {});
})();
