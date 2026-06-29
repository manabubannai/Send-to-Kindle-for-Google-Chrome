const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(text, kind) {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = "status " + (kind || "");
}

function run(mode) {
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  setStatus(mode === "send" ? "Sending…" : "Extracting…", "busy");

  chrome.runtime.sendMessage({ mode }, (res) => {
    buttons.forEach((b) => (b.disabled = false));
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, "err");
      return;
    }
    if (!res) {
      setStatus("No response from background.", "err");
      return;
    }
    setStatus(res.message, res.ok ? "ok" : "err");
  });
}

$("send").addEventListener("click", () => run("send"));
$("download").addEventListener("click", () => run("download"));
$("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
