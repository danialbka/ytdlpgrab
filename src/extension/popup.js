const dot = document.getElementById("dot");
const statusText = document.getElementById("status");
const detail = document.getElementById("detail");

function setStatus(kind, message, extra = "") {
  dot.className = `dot ${kind}`;
  statusText.textContent = message;
  detail.textContent = extra;
}

fetch("http://127.0.0.1:17427/health")
  .then((response) => response.json())
  .then((health) => {
    if (!health.tools?.ytDlp?.available) {
      setStatus(
        "bad",
        "Helper is running, yt-dlp is missing.",
        "Run: npm run install:yt-dlp"
      );
      return;
    }

    setStatus(
      "ok",
      "Ready for Desktop drops.",
      [
        health.mode?.label || "YouTube Video",
        `yt-dlp ${health.tools.ytDlp.version || ""}`.trim()
      ]
        .filter(Boolean)
        .join(" | ")
    );
  })
  .catch(() => {
    setStatus("bad", "Helper is not running.", "Start it with: npm start");
  });
