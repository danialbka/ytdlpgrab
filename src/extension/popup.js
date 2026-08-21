(() => {
  const HELPER_ORIGIN = "http://127.0.0.1:17427";
  const PROGRESS_POLL_MS = 800;
  const dot = document.getElementById("dot");
  const statusText = document.getElementById("status");
  const detail = document.getElementById("detail");
  const downloadButton = document.getElementById("download-current");
  const currentDetail = document.getElementById("current-detail");
  const actionStatus = document.getElementById("action-status");
  const downloadProgress = document.getElementById("download-progress");
  const progressBar = document.getElementById("progress-bar");
  const progressFill = document.getElementById("progress-fill");
  const progressLabel = document.getElementById("progress-label");
  const updateBanner = document.getElementById("update-banner");
  const updateBannerLabel = document.getElementById("update-banner-label");
  if (
    !dot ||
    !statusText ||
    !detail ||
    !downloadButton ||
    !currentDetail ||
    !actionStatus ||
    !downloadProgress ||
    !progressBar ||
    !progressFill ||
    !progressLabel ||
    !updateBanner ||
    !updateBannerLabel
  ) {
    return;
  }

  let helperReady = false;
  let currentVideo = null;
  let saving = false;
  let phase = "idle";
  let prepPercent = null;
  let downloadPercent = null;
  let trackedDownloadId = null;

  function setStatus(kind, message, extra = "") {
    dot.className = `dot ${kind}`;
    statusText.textContent = message;
    detail.textContent = extra;
  }

  function setActionStatus(kind, message = "") {
    actionStatus.className = `action-status${kind ? ` ${kind}` : ""}`;
    actionStatus.textContent = message;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1000) {
      return `${Math.round(value)} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let scaled = value;
    let unitIndex = -1;
    do {
      scaled /= 1000;
      unitIndex += 1;
    } while (scaled >= 1000 && unitIndex < units.length - 1);

    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unitIndex]}`;
  }

  function hideProgress() {
    downloadProgress.hidden = true;
    progressFill.style.width = "0%";
    progressBar.classList.remove("indeterminate");
    progressBar.removeAttribute("aria-valuenow");
    progressLabel.textContent = "";
  }

  function showIndeterminateProgress(message) {
    downloadProgress.hidden = false;
    progressBar.classList.add("indeterminate");
    progressFill.style.width = "";
    progressBar.removeAttribute("aria-valuenow");
    progressLabel.textContent = message;
  }

  function showDeterminateProgress(percent, message) {
    downloadProgress.hidden = false;
    progressBar.classList.remove("indeterminate");
    progressFill.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuenow", String(percent));
    progressLabel.textContent = message;
  }

  function buttonLabel() {
    if (saving) {
      return "Starting download...";
    }

    if (phase === "preparing") {
      return prepPercent === null ? "Preparing..." : `Preparing… ${prepPercent}%`;
    }

    if (phase === "downloading") {
      return downloadPercent === null
        ? "Downloading..."
        : `Downloading… ${downloadPercent}%`;
    }

    return "Download current video";
  }

  function refreshButton() {
    const busy = Boolean(
      saving || phase === "preparing" || phase === "downloading"
    );
    downloadButton.disabled = busy || !helperReady || !currentVideo;
    downloadButton.textContent = buttonLabel();
  }

  function fetchProgress(videoUrl) {
    const url = new URL("/progress", HELPER_ORIGIN);
    url.searchParams.set("url", videoUrl);

    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), 3000);
    return fetch(url, { signal: ac.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .finally(() => clearTimeout(timeoutId));
  }

  function waitForCache(videoUrl) {
    phase = "preparing";
    prepPercent = null;
    refreshButton();

    let sawActive = false;

    const tick = async () => {
      if (phase !== "preparing") {
        return;
      }

      let progress = null;
      try {
        progress = await fetchProgress(videoUrl);
      } catch {
        if (phase === "preparing") {
          setTimeout(tick, PROGRESS_POLL_MS);
        }
        return;
      }

      if (phase !== "preparing") {
        return;
      }

      if (progress.active) {
        sawActive = true;
      }
      prepPercent =
        progress.percent === null ? null : Math.min(100, progress.percent);
      refreshButton();

      if (progress.cached) {
        startBrowserDownloadForCurrentVideo();
        return;
      }

      if (!progress.active && sawActive) {
        phase = "idle";
        prepPercent = null;
        setActionStatus("error", "The helper stopped preparing the download.");
        refreshButton();
        return;
      }

      setTimeout(tick, PROGRESS_POLL_MS);
    };

    tick();
  }

  function applyDownloadItem(item) {
    if (!item) {
      return;
    }

    if (item.state === "complete") {
      phase = "idle";
      downloadPercent = 100;
      showDeterminateProgress(
        100,
        `Download complete · ${formatBytes(item.totalBytes || item.bytesReceived)}`
      );
      setActionStatus("success", "Saved via your browser downloads.");
      refreshButton();
      return;
    }

    if (item.state === "interrupted") {
      phase = "idle";
      downloadPercent = null;
      trackedDownloadId = null;
      hideProgress();
      setActionStatus(
        "error",
        item.error ? `Download failed: ${item.error}.` : "Download failed."
      );
      refreshButton();
      return;
    }

    phase = "downloading";
    const received = Number(item.bytesReceived) || 0;
    const total = Number(item.totalBytes) || 0;

    if (total > 0) {
      downloadPercent = Math.min(100, Math.round((received / total) * 100));
      showDeterminateProgress(
        downloadPercent,
        `Downloading… ${downloadPercent}% · ${formatBytes(received)} of ${formatBytes(total)}`
      );
    } else {
      downloadPercent = null;
      showIndeterminateProgress(`Downloading… ${formatBytes(received)}`);
    }
    refreshButton();
  }

  function onDownloadChanged(delta) {
    if (delta.id !== trackedDownloadId) {
      return;
    }

    chrome.downloads.search({ id: delta.id }, (items) => {
      applyDownloadItem(items?.[0]);
    });
  }

  function watchDownload(downloadId) {
    trackedDownloadId = downloadId;
    phase = "downloading";
    downloadPercent = null;
    showIndeterminateProgress("Downloading…");
    refreshButton();

    if (!chrome.downloads.onChanged.hasListener(onDownloadChanged)) {
      chrome.downloads.onChanged.addListener(onDownloadChanged);
    }

    chrome.downloads.search({ id: downloadId }, (items) => {
      applyDownloadItem(items?.[0]);
    });
  }

  async function startBrowserDownloadForCurrentVideo() {
    if (!currentVideo) {
      return;
    }

    try {
      const response = await sendMessage({
        type: "ytdlpgrab.start-browser-download",
        videoUrl: currentVideo.videoUrl,
        name: currentVideo.name
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Could not start the download.");
      }

      setActionStatus(
        "success",
        "Choose where to save the file in the Chromium dialog."
      );
      watchDownload(response.downloadId);
    } catch (error) {
      phase = "idle";
      prepPercent = null;
      setActionStatus("error", error.message);
      refreshButton();
    }
  }

  function resumeActiveWork(videoUrl) {    chrome.downloads.search({}, (items) => {
      const match = (items || [])
        .filter((item) => item.state === "in_progress")
        .find((item) => {
          try {
            return (
              new URL(item.url).origin === HELPER_ORIGIN &&
              new URL(item.url).searchParams.get("url") === videoUrl
            );
          } catch {
            return false;
          }
        });

      if (match && phase !== "preparing") {
        watchDownload(match.id);
      }
    });

    fetchProgress(videoUrl)
      .then((progress) => {
        if (
          progress.active &&
          !progress.cached &&
          phase === "idle" &&
          !trackedDownloadId
        ) {
          setActionStatus("", "Preparing the video…");
          waitForCache(videoUrl);
        }
      })
      .catch(() => {});
  }

  function sendMessage(message) {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      return Promise.reject(
        new Error("Open a YouTube video, Short, or live stream first.")
      );
    }

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), 3000);
  fetch("http://127.0.0.1:17427/health", { signal: ac.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((health) => {
      if (!health.tools?.ytDlp?.available) {
        setStatus(
          "warn",
          "Helper running, yt-dlp missing.",
          [health.mode?.label || "YouTube Video", "Run: npm run install:yt-dlp"]
            .filter(Boolean)
            .join(" | ")
        );
        return;
      }

      helperReady = true;
      setStatus(
        "ok",
        "Ready to download.",
        [
          health.mode?.label || "YouTube Video",
          `yt-dlp ${health.tools.ytDlp.version || ""}`.trim()
        ]
          .filter(Boolean)
          .join(" | ")
      );
    })
    .catch((error) => {
      if (error.message.startsWith("HTTP ")) {
        setStatus("bad", "Helper returned an error.", `Status: ${error.message.slice(5)}`);
      } else if (error.name === "AbortError") {
        setStatus("bad", "Helper is not responding.", "Check if it is running.");
      } else {
        setStatus("bad", "Helper is not running.", "Start the YTDLPGrab app.");
      }
    })
    .finally(() => {
      clearTimeout(timeoutId);
      refreshButton();
    });

  sendMessage({ type: "ytdlpgrab.current-video" })
    .then((response) => {
      if (!response?.ok) {
        throw new Error(response?.error || "The current tab is not a supported video.");
      }

      currentVideo = response.video;
      currentDetail.textContent = currentVideo.name;
      resumeActiveWork(currentVideo.videoUrl);
    })
    .catch((error) => {
      currentVideo = null;
      currentDetail.textContent = error.message;
    })
    .finally(refreshButton);

  downloadButton.addEventListener("click", async () => {
    if (saving || !helperReady || !currentVideo) {
      return;
    }

    if (phase === "preparing" || phase === "downloading") {
      return;
    }

    saving = true;
    phase = "idle";
    prepPercent = null;
    downloadPercent = null;
    trackedDownloadId = null;
    hideProgress();
    setActionStatus("", "");
    refreshButton();

    try {
      const response = await sendMessage({
        type: "ytdlpgrab.save-current-video"
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Could not start the download.");
      }

      currentVideo = response.video;
      currentDetail.textContent = currentVideo.name;

      if (response.cached) {
        await startBrowserDownloadForCurrentVideo();
      } else {
        setActionStatus("", "Preparing the video…");
        waitForCache(currentVideo.videoUrl);
      }
    } catch (error) {
      setActionStatus("error", error.message);
    } finally {
      saving = false;
      refreshButton();
    }
  });

  let lastUpdateCheck = null;

  function showUpdateBanner(update) {
    if (!update || update.ok !== true || update.updateAvailable !== true) {
      updateBanner.hidden = true;
      return;
    }

    updateBannerLabel.textContent = `Update available · v${update.latest}`;
    updateBanner.hidden = false;
  }

  function openReleasePage(update) {
    const url =
      update?.releaseUrl ||
      "https://github.com/danialbka/ytdlpgrab/releases/latest";
    try {
      chrome.tabs.create({ url });
    } catch {
      window.open(url, "_blank");
    }
  }

  updateBanner.addEventListener("click", () => {
    if (lastUpdateCheck) {
      openReleasePage(lastUpdateCheck);
    }
  });

  try {
    chrome.storage.local.get("updateCheck", (stored) => {
      lastUpdateCheck = stored?.updateCheck?.result || null;
      showUpdateBanner(lastUpdateCheck);
    });
  } catch {
    // Storage may be unavailable in dev harnesses.
  }

  sendMessage({ type: "ytdlpgrab.update-check" })
    .then((response) => {
      if (response?.ok && response.update) {
        lastUpdateCheck = response.update;
        showUpdateBanner(lastUpdateCheck);
      }
    })
    .catch(() => {});
})();
