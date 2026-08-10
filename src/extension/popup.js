(() => {
  const dot = document.getElementById("dot");
  const statusText = document.getElementById("status");
  const detail = document.getElementById("detail");
  const downloadButton = document.getElementById("download-current");
  const currentDetail = document.getElementById("current-detail");
  const actionStatus = document.getElementById("action-status");
  if (
    !dot ||
    !statusText ||
    !detail ||
    !downloadButton ||
    !currentDetail ||
    !actionStatus
  ) {
    return;
  }

  let helperReady = false;
  let currentVideo = null;
  let saving = false;

  function setStatus(kind, message, extra = "") {
    dot.className = `dot ${kind}`;
    statusText.textContent = message;
    detail.textContent = extra;
  }

  function setActionStatus(kind, message = "") {
    actionStatus.className = `action-status${kind ? ` ${kind}` : ""}`;
    actionStatus.textContent = message;
  }

  function refreshButton() {
    downloadButton.disabled = saving || !helperReady || !currentVideo;
    downloadButton.textContent = saving
      ? "Starting download..."
      : "Download current video";
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

    saving = true;
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
      setActionStatus("success", "Choose where to save the file in the Chromium dialog.");
    } catch (error) {
      setActionStatus("error", error.message);
    } finally {
      saving = false;
      refreshButton();
    }
  });
})();
