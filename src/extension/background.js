(() => {
  const HELPER_ORIGIN = "http://127.0.0.1:17427";
  const TRUSTED_ACTION_HEADER = "x-ytdlpgrab-extension";
  const TRUSTED_ACTION_VALUE = "1";
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
    try {
      const senderUrl = new URL(sender.url || sender.tab?.url || "");
      return ALLOWED_PAGE_HOSTS.has(senderUrl.hostname.toLowerCase());
    } catch {
      return false;
    }
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
    const response = await fetch(helperUrl(pathname, videoUrl, name, destination), {
      method: "POST",
      headers: {
        [TRUSTED_ACTION_HEADER]: TRUSTED_ACTION_VALUE
      }
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `Helper returned ${response.status}.`);
    }

    return body;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type !== "ytdlpgrab.save") {
      return false;
    }

    if (!isAllowedSender(sender)) {
      sendResponse({ ok: false, error: "Sender is not a YouTube page." });
      return false;
    }

    const videoUrl = normalizeVideoUrl(message.videoUrl);
    if (!videoUrl) {
      sendResponse({ ok: false, error: "Message did not include a YouTube video URL." });
      return false;
    }

    postHelper(
      "/save",
      videoUrl,
      message.name,
      message.destination || "desktop"
    )
      .then((body) => sendResponse({ ok: true, body }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  });
})();
