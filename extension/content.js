(() => {
  const HELPER_ORIGIN = "http://127.0.0.1:17427";
  const READY_CLASS = "ytdlpgrab-ready";
  let activeDrag = null;
  let pendingPointerAnchor = null;
  const THUMBNAIL_CONTAINER_SELECTOR = [
    "ytd-thumbnail",
    "yt-thumbnail-view-model"
  ].join(",");
  const THUMBNAIL_ANCHOR_SELECTOR = [
    "a#thumbnail[href]",
    "ytd-thumbnail a[href]",
    "yt-thumbnail-view-model a[href]"
  ].join(",");

  function normalizeVideoUrl(rawHref) {
    try {
      const url = new URL(rawHref, location.href);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");

      if (host === "youtu.be") {
        const id = url.pathname.split("/").filter(Boolean)[0];
        return id ? `https://www.youtube.com/watch?v=${id}` : null;
      }

      if (
        host !== "youtube.com" &&
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

  function sanitizeFileName(value) {
    const text = String(value || "")
      .replace(/\s+-\s+YouTube\s*$/i, "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[\\/:*?"<>|#%{}$!`+=@]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90);

    return text || "youtube-video";
  }

  function titleFromAnchor(anchor) {
    const container = anchor.closest?.(
      [
        "ytd-rich-grid-media",
        "ytd-video-renderer",
        "ytd-compact-video-renderer",
        "ytd-rich-item-renderer",
        "yt-lockup-view-model",
        "ytd-watch-next-secondary-results-renderer"
      ].join(",")
    );
    const candidates = [
      container?.querySelector("#video-title")?.textContent,
      container?.querySelector("h3 a")?.textContent,
      container?.querySelector("h3")?.textContent,
      container?.querySelector("a[title]")?.getAttribute("title"),
      anchor.getAttribute("aria-label"),
      anchor.getAttribute("title"),
      anchor.textContent,
      document.title
    ];

    return sanitizeFileName(candidates.find((candidate) => candidate?.trim()));
  }

  function isCommentLink(anchor) {
    return Boolean(
      anchor.closest?.(
        [
          "ytd-comment-thread-renderer",
          "ytd-comment-view-model",
          "ytd-comment-renderer",
          "ytd-comments"
        ].join(",")
      )
    );
  }

  function isVisualVideoAnchor(anchor) {
    if (!anchor || !normalizeVideoUrl(anchor.href) || isCommentLink(anchor)) {
      return false;
    }

    return Boolean(
      anchor.id === "thumbnail" ||
        anchor.closest?.("ytd-thumbnail, yt-thumbnail-view-model") ||
        anchor.querySelector?.("img, yt-image, ytd-thumbnail-overlay-time-status-renderer")
    );
  }

  function thumbnailAnchorFromElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const directAnchor = element.closest?.("a#thumbnail[href]");
    if (directAnchor && isVisualVideoAnchor(directAnchor)) {
      return directAnchor;
    }

    const thumbnailContainer = element.closest?.(THUMBNAIL_CONTAINER_SELECTOR);
    const containerAnchor = thumbnailContainer?.querySelector?.("a[href]");
    if (containerAnchor && isVisualVideoAnchor(containerAnchor)) {
      return containerAnchor;
    }

    const visualAnchor = element.closest?.("a[href]");
    if (visualAnchor && isVisualVideoAnchor(visualAnchor)) {
      return visualAnchor;
    }

    return null;
  }

  function findThumbnailAnchorFromPoint(event) {
    if (
      typeof document.elementsFromPoint !== "function" ||
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY)
    ) {
      return null;
    }

    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      const anchor = thumbnailAnchorFromElement(element);
      if (anchor?.classList?.contains(READY_CLASS)) {
        return anchor;
      }
    }

    return null;
  }

  function findThumbnailAnchorInPath(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of [event.target, ...path]) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const anchor = thumbnailAnchorFromElement(node);
      if (anchor?.classList?.contains(READY_CLASS)) {
        return anchor;
      }
    }

    return null;
  }

  function findVideoAnchor(event) {
    return (
      findThumbnailAnchorFromPoint(event) ||
      findThumbnailAnchorInPath(event) ||
      (pendingPointerAnchor?.isConnected && isVisualVideoAnchor(pendingPointerAnchor)
        ? pendingPointerAnchor
        : null)
    );
  }

  function helperUrl(pathname, videoUrl, name) {
    const url = new URL(pathname, HELPER_ORIGIN);
    url.searchParams.set("url", videoUrl);
    url.searchParams.set("name", name);
    return url.toString();
  }

  function saveToDesktop(videoUrl, name) {
    const url = new URL(helperUrl("/save", videoUrl, name));
    url.searchParams.set("destination", "desktop");

    fetch(url.toString(), {
      method: "GET",
      mode: "cors",
      keepalive: true
    }).catch(() => {
      // The helper popup reports connection state; avoid interrupting the drag.
    });
  }

  function capturePointerTarget(event) {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }

    activeDrag = null;
    pendingPointerAnchor =
      findThumbnailAnchorFromPoint(event) || findThumbnailAnchorInPath(event);
  }

  function attachDragPayload(event) {
    const anchor = findVideoAnchor(event);
    const videoUrl = anchor?.href ? normalizeVideoUrl(anchor.href) : null;

    if (!videoUrl || !event.dataTransfer) {
      activeDrag = null;
      pendingPointerAnchor = null;
      return;
    }

    const name = titleFromAnchor(anchor);
    pendingPointerAnchor = null;

    event.dataTransfer.clearData();
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-ytdlpgrab-url", videoUrl);
    event.dataTransfer.setData("application/x-ytdlpgrab-name", name);
    event.stopImmediatePropagation();

    activeDrag = {
      videoUrl,
      name,
      startedAt: Date.now()
    };
  }

  function finishDrag(event) {
    if (!activeDrag) {
      return;
    }

    const drag = activeDrag;
    activeDrag = null;

    if (event.dataTransfer?.dropEffect === "none" && Date.now() - drag.startedAt < 500) {
      return;
    }

    saveToDesktop(drag.videoUrl, drag.name);
  }

  function collectThumbnailAnchors(root = document) {
    const anchors = new Set(root.querySelectorAll?.(THUMBNAIL_ANCHOR_SELECTOR) || []);
    const visualChildren =
      root.querySelectorAll?.(
        [
          "a[href] img",
          "a[href] yt-image",
          "a[href] ytd-thumbnail-overlay-time-status-renderer"
        ].join(",")
      ) || [];

    for (const child of visualChildren) {
      const anchor = child.closest?.("a[href]");
      if (anchor) {
        anchors.add(anchor);
      }
    }

    return anchors;
  }

  function markAnchors(root = document) {
    const marked = root.querySelectorAll?.(`.${READY_CLASS}`) || [];
    for (const anchor of marked) {
      if (!isVisualVideoAnchor(anchor)) {
        anchor.classList.remove(READY_CLASS);
      }
    }

    for (const anchor of collectThumbnailAnchors(root)) {
      if (isVisualVideoAnchor(anchor)) {
        anchor.classList.add(READY_CLASS);
        anchor.draggable = true;

        for (const image of anchor.querySelectorAll("img")) {
          image.draggable = false;
        }
      }
    }
  }

  const scheduleMarkAnchors = (() => {
    let timer = null;
    return () => {
      if (timer) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        markAnchors();
      }, 250);
    };
  })();

  document.addEventListener("pointerdown", capturePointerTarget, true);
  document.addEventListener("mousedown", capturePointerTarget, true);
  document.addEventListener("dragstart", attachDragPayload, true);
  document.addEventListener("dragend", finishDrag, true);
  markAnchors();

  const observer = new MutationObserver(scheduleMarkAnchors);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
