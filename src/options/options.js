const kindleEmail = document.getElementById("kindleEmail");
const backendUrl = document.getElementById("backendUrl");
const saved = document.getElementById("saved");

chrome.storage.sync.get(["kindleEmail", "backendUrl"], (cfg) => {
  kindleEmail.value = cfg.kindleEmail || "";
  backendUrl.value = cfg.backendUrl || "";
});

document.getElementById("save").addEventListener("click", () => {
  chrome.storage.sync.set(
    {
      kindleEmail: kindleEmail.value.trim(),
      backendUrl: backendUrl.value.trim(),
    },
    () => {
      saved.hidden = false;
      setTimeout(() => (saved.hidden = true), 1800);
    }
  );
});
