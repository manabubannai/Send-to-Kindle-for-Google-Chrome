// One tap = one send: opening this popup immediately queues the current tab
// for sending, then shows the live activity list (the send itself runs in the
// background, so the popup can be closed at once). Two guards keep a
// history-checking tap from firing an accidental send:
//   1. unreviewed failures exist (red badge) — the user probably opened the
//      popup to read them, so show them and offer an explicit send button;
//   2. this exact URL was sent successfully in the last few minutes — offer
//      "Send again" instead of silently duplicating.

const RESEND_GUARD_MS = 3 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const resendBtn = $("resend");
const activityEl = $("activity");
const jobsEl = $("jobs");

let currentTab = null;

function setStatus(text, kind) {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = "status " + (kind || "");
}

function showSendButton(label) {
  resendBtn.hidden = false;
  resendBtn.textContent = label;
}

function enqueue(tab) {
  chrome.runtime.sendMessage(
    { type: "enqueue", mode: "send", tab: { id: tab.id, title: tab.title, url: tab.url } },
    (res) => {
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, "err");
        return;
      }
      if (!res) {
        setStatus("No response from background.", "err");
        return;
      }
      if (!res.ok) {
        setStatus(res.message, "err");
        return;
      }
      // Queued: the activity list shows it live; nothing else to say.
      statusEl.hidden = true;
      resendBtn.hidden = true;
    }
  );
}

const isProblem = (j) => j.status === "error" || j.status === "warn";

function decide(jobs) {
  if (!currentTab || !currentTab.id) {
    setStatus("No active tab.", "err");
    return;
  }
  const unseen = jobs.filter((j) => isProblem(j) && !j.seen).length;
  if (unseen > 0) {
    setStatus(
      `${unseen} failed send${unseen === 1 ? "" : "s"} below — this page was NOT auto-sent.`,
      "busy"
    );
    showSendButton("Send this page");
    return;
  }
  if (jobs.some((j) => j.status === "running" && j.tabId === currentTab.id)) {
    return; // already in flight; the list shows the spinner
  }
  const recent = jobs.find(
    (j) =>
      (j.status === "ok" || j.status === "warn") &&
      j.url === currentTab.url &&
      j.finishedAt &&
      Date.now() - j.finishedAt < RESEND_GUARD_MS
  );
  if (recent) {
    setStatus(`Already sent at ${timeLabel(recent)}.`, "ok");
    showSendButton("Send again");
    return;
  }
  enqueue(currentTab);
}

/* ---------------------------- activity list ---------------------------- */

const STATUS_ICON = { ok: "✓", warn: "!", error: "✕" };

function timeLabel(job) {
  const ts = job.finishedAt || job.startedAt;
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function render(jobs) {
  const scrollTop = jobsEl.scrollTop; // survive re-renders mid-scroll
  activityEl.hidden = jobs.length === 0;
  jobsEl.textContent = "";
  for (const job of jobs) {
    const li = document.createElement("li");
    li.className = "job " + job.status;

    const icon = document.createElement("span");
    icon.className = "job-icon " + job.status;
    if (job.status === "running") icon.classList.add("spin");
    else icon.textContent = STATUS_ICON[job.status] || "?";

    const body = document.createElement("div");
    body.className = "job-body";

    const title = document.createElement("div");
    title.className = "job-title";
    title.textContent = (job.mode === "download" ? "[HTML] " : "") + (job.title || job.url || "Untitled");
    title.title = job.url || "";

    const msg = document.createElement("div");
    msg.className = "job-msg";
    msg.textContent = job.message || "";

    body.append(title, msg);

    const when = document.createElement("span");
    when.className = "job-time";
    when.textContent = timeLabel(job);

    li.append(icon, body, when);
    jobsEl.append(li);
  }
  jobsEl.scrollTop = scrollTop;
}

// Viewing the popup acknowledges finished failures → background clears the
// red badge. Guarded so the resulting storage change can't loop.
function markSeenIfNeeded(jobs) {
  if (jobs.some((j) => isProblem(j) && !j.seen)) {
    chrome.runtime.sendMessage({ type: "markSeen" }, () => void chrome.runtime.lastError);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.jobs) {
    const jobs = changes.jobs.newValue || [];
    render(jobs);
    markSeenIfNeeded(jobs);
  }
});

resendBtn.addEventListener("click", () => {
  if (currentTab) enqueue(currentTab);
});
$("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clearHistory" }, () => void chrome.runtime.lastError);
});
$("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Wake the service worker even on paths that send no other message, so its
// cold-start reaper flags orphaned jobs the moment the popup opens.
chrome.runtime.sendMessage({ type: "wake" }, () => void chrome.runtime.lastError);

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  currentTab = (tabs && tabs[0]) || null;
  chrome.storage.session.get("jobs", ({ jobs = [] }) => {
    render(jobs);
    decide(jobs);
    markSeenIfNeeded(jobs);
  });
});
