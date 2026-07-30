(() => {
  const READY_CLASS = "ytdlpgrab-ready";
  const MIN_DRAG_SAVE_MS = 500;
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
  const VIDEO_ITEM_SELECTOR = [
    "ytd-rich-grid-media",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-rich-item-renderer",
    "yt-lockup-view-model",
    "ytd-watch-next-secondary-results-renderer",
    "ytd-playlist-panel-video-renderer"
  ].join(",");
  const VIDEO_LINK_SELECTOR = [
    'a#video-title[href]',
    'h3 a[href*="/watch"]',
    'h3 a[href*="/shorts/"]',
    'a[href*="/watch"]',
    'a[href*="/shorts/"]',
    'a[href*="/live/"]',
    'a[href^="https://youtu.be/"]'
  ].join(",");
  const VIDEO_MEDIA_SELECTOR = [
    "img",
    "yt-image",
    "ytd-thumbnail-overlay-time-status-renderer"
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
      .trim();
    const sliced = Array.from(text).slice(0, 90).join('');

    return sliced || "youtube-video";
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

  function isVideoHref(anchor) {
    if (!anchor || !normalizeVideoUrl(anchor.href) || isCommentLink(anchor)) {
      return false;
    }

    return true;
  }

  function isThumbnailVideoAnchor(anchor) {
    if (!isVideoHref(anchor)) {
      return false;
    }

    return Boolean(
      anchor.id === "thumbnail" ||
        anchor.closest?.("ytd-thumbnail, yt-thumbnail-view-model") ||
        anchor.querySelector?.(VIDEO_MEDIA_SELECTOR)
    );
  }

  function isTitleVideoAnchor(anchor) {
    if (!isVideoHref(anchor)) {
      return false;
    }

    const container = anchor.closest?.(VIDEO_ITEM_SELECTOR);
    if (!container) {
      return false;
    }

    return Boolean(
      anchor.id === "video-title" ||
        anchor.matches?.(VIDEO_LINK_SELECTOR) ||
        anchor.closest?.("h3") ||
        container.querySelector?.("a#video-title[href]") === anchor
    );
  }

  function isHandledVideoAnchor(anchor) {
    return isThumbnailVideoAnchor(anchor) || isTitleVideoAnchor(anchor);
  }

  function queryAnchorInContainer(container) {
    try {
      return container?.querySelector?.("a[href]");
    } catch {
      const root = container?.getRootNode?.();
      if (root instanceof ShadowRoot) {
        return root.host?.querySelector?.("a[href]");
      }
      return null;
    }
  }

  function videoAnchorFromElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const directAnchor = element.closest?.("a#thumbnail[href]");
    if (directAnchor && isHandledVideoAnchor(directAnchor)) {
      return directAnchor;
    }

    const thumbnailContainer = element.closest?.(THUMBNAIL_CONTAINER_SELECTOR);
    const containerAnchor = queryAnchorInContainer(thumbnailContainer);
    if (containerAnchor && isHandledVideoAnchor(containerAnchor)) {
      return containerAnchor;
    }

    const linkAnchor = element.closest?.("a[href]");
    if (linkAnchor && isHandledVideoAnchor(linkAnchor)) {
      return linkAnchor;
    }

    return null;
  }

  function findVideoAnchorFromPoint(event) {
    if (
      typeof document.elementsFromPoint !== "function" ||
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY)
    ) {
      return null;
    }

    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      const anchor = videoAnchorFromElement(element);
      if (anchor?.classList?.contains(READY_CLASS)) {
        return anchor;
      }
    }

    return null;
  }

  function findVideoAnchorInPath(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const anchor = videoAnchorFromElement(node);
      if (anchor?.classList?.contains(READY_CLASS)) {
        return anchor;
      }
    }

    return null;
  }

  function findVideoAnchor(event) {
    return (
      findVideoAnchorFromPoint(event) ||
      findVideoAnchorInPath(event) ||
      (pendingPointerAnchor?.isConnected && isHandledVideoAnchor(pendingPointerAnchor)
        ? pendingPointerAnchor
        : null)
    );
  }

  function saveToDesktop(videoUrl, name) {
    chrome.runtime.sendMessage(
      {
        type: "ytdlpgrab.save",
        videoUrl,
        name,
        destination: "desktop"
      },
      () => {
        if (chrome.runtime.lastError) {
          console.error("ytdlpgrab: save error", chrome.runtime.lastError);
        }
      }
    );
  }

  function capturePointerTarget(event) {
    if (event.button !== undefined && event.button !== 0) {
      pendingPointerAnchor = null;
      return;
    }

    activeDrag = null;
    pendingPointerAnchor =
      findVideoAnchorFromPoint(event) || findVideoAnchorInPath(event);
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
      startedAt: Date.now(),
      leftDocument: false
    };
  }

  function trackDragLocation(event) {
    if (!activeDrag) {
      return;
    }

    const outsideViewport =
      event.clientX <= 0 ||
      event.clientY <= 0 ||
      event.clientX >= window.innerWidth ||
      event.clientY >= window.innerHeight;

    if (outsideViewport || (event.type === "dragleave" && event.relatedTarget === null)) {
      activeDrag.leftDocument = true;
      return;
    }

    if (event.type === "dragover") {
      activeDrag.leftDocument = false;
    }
  }

  function finishDrag(event) {
    if (!activeDrag) {
      return;
    }

    const drag = activeDrag;
    activeDrag = null;

    const elapsedMs = Date.now() - drag.startedAt;
    if (
      event.dataTransfer?.dropEffect === "none" &&
      !drag.leftDocument &&
      elapsedMs < MIN_DRAG_SAVE_MS
    ) {
      return;
    }

    saveToDesktop(drag.videoUrl, drag.name);
  }

  function matchingElements(root, selector) {
    const elements = [];
    if (!root) {
      return elements;
    }

    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(selector)) {
      elements.push(root);
    }

    for (const element of root.querySelectorAll?.(selector) || []) {
      elements.push(element);
    }

    return elements;
  }

  function collectHandledAnchors(root = document) {
    const anchors = new Set(matchingElements(root, THUMBNAIL_ANCHOR_SELECTOR));
    const videoItems = matchingElements(root, VIDEO_ITEM_SELECTOR);
    for (const item of videoItems) {
      for (const anchor of item.querySelectorAll?.(VIDEO_LINK_SELECTOR) || []) {
        anchors.add(anchor);
      }
    }

    const visualChildren =
      matchingElements(
        root,
        [
          "a[href] img",
          "a[href] yt-image",
          "a[href] ytd-thumbnail-overlay-time-status-renderer"
        ].join(",")
      );

    for (const child of visualChildren) {
      const anchor = child.closest?.("a[href]");
      if (anchor) {
        anchors.add(anchor);
      }
    }

    return anchors;
  }

  function markAnchors(root = document) {
    const marked = matchingElements(root, `.${READY_CLASS}`);
    for (const anchor of marked) {
      if (!isHandledVideoAnchor(anchor) && anchor.classList.contains(READY_CLASS)) {
        anchor.classList.remove(READY_CLASS);
      }
    }

    for (const anchor of collectHandledAnchors(root)) {
      if (isHandledVideoAnchor(anchor)) {
        if (!anchor.classList.contains(READY_CLASS)) {
          anchor.classList.add(READY_CLASS);
          anchor.draggable = true;
        }

        for (const image of anchor.querySelectorAll("img")) {
          image.draggable = false;
        }
      }
    }
  }

  function scanRootFor(element) {
    return (
      element.closest?.(VIDEO_ITEM_SELECTOR) ||
      element.closest?.(THUMBNAIL_CONTAINER_SELECTOR) ||
      element.closest?.("a[href]") ||
      element
    );
  }

  function mutationRoots(mutations) {
    const roots = new Set();
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        if (mutation.target?.nodeType === Node.ELEMENT_NODE) {
          roots.add(scanRootFor(mutation.target));
        }
        continue;
      }

      for (const node of [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])]) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          roots.add(scanRootFor(node));
        }
      }
    }

    return roots;
  }

  const scheduleMarkAnchors = (() => {
    let timer = null;
    const roots = new Set();

    return (nextRoots) => {
      for (const root of nextRoots || [document]) {
        roots.add(root);
      }

      if (timer) {
        return;
      }
      timer = window.requestAnimationFrame(() => {
        timer = null;
        const pendingRoots = Array.from(roots);
        roots.clear();

        for (const root of pendingRoots) {
          if (root === document || root.isConnected) {
            markAnchors(root);
          }
        }
      });
    };
  })();

  const scheduleMarkAnchorsAria = (() => {
    let timer = null;
    const roots = new Set();

    return (nextRoots) => {
      for (const root of nextRoots || [document]) {
        roots.add(root);
      }

      if (timer) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        const pendingRoots = Array.from(roots);
        roots.clear();

        for (const root of pendingRoots) {
          if (root === document || root.isConnected) {
            markAnchors(root);
          }
        }
      }, 500);
    };
  })();

  document.addEventListener("pointerdown", capturePointerTarget, true);
  document.addEventListener("mousedown", capturePointerTarget, true);
  document.addEventListener("dragstart", attachDragPayload, true);
  document.addEventListener("dragover", trackDragLocation, true);
  document.addEventListener("dragleave", trackDragLocation, true);
  document.addEventListener("dragend", finishDrag, true);
  markAnchors();

  const observer = new MutationObserver((mutations) => {
    const roots = mutationRoots(mutations);
    if (roots.size > 0) {
      scheduleMarkAnchors(roots);
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["href", "title", "class", "hidden"],
    childList: true,
    subtree: true
  });

  const ariaObserver = new MutationObserver((mutations) => {
    const roots = mutationRoots(mutations);
    if (roots.size > 0) {
      scheduleMarkAnchorsAria(roots);
    }
  });
  ariaObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["aria-label"],
    subtree: true
  });
})();
