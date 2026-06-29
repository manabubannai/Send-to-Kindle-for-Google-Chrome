// Service worker: orchestrates extraction -> clean HTML -> download or email relay.

/** Inject Readability + extractor into the active tab and return the parsed article. */
async function extractArticle(tabId) {
  // 1) Load the Readability library into the page's isolated world.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/vendor/Readability.js"],
  });

  // 2) Run the parser against a clone of the live document.
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try {
        if (typeof Readability === "undefined") {
          return { __error: "Readability did not load" };
        }
        const documentClone = document.cloneNode(true);
        const article = new Readability(documentClone).parse();
        if (!article) return null;
        return {
          title: article.title || document.title || "Untitled",
          content: article.content || "",
          byline: article.byline || "",
          excerpt: article.excerpt || "",
          siteName: article.siteName || "",
          length: article.length || 0,
          url: location.href,
        };
      } catch (e) {
        return { __error: String(e) };
      }
    },
  });
  return result;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap the extracted content in a clean, Kindle-friendly HTML document. */
function buildHtml(article) {
  const title = escapeHtml(article.title);
  const byline = article.byline
    ? `<p class="byline">${escapeHtml(article.byline)}</p>`
    : "";
  const site = article.siteName ? escapeHtml(article.siteName) : "";
  const url = escapeHtml(article.url);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; line-height: 1.6; max-width: 40em; margin: 0 auto; padding: 1.2em; }
  h1 { font-size: 1.6em; line-height: 1.25; }
  img { max-width: 100%; height: auto; }
  figure { margin: 1em 0; }
  blockquote { border-left: 3px solid #ccc; margin: 1em 0; padding-left: 1em; color: #444; }
  pre { white-space: pre-wrap; word-wrap: break-word; }
  .byline { color: #555; font-style: italic; margin-top: 0; }
  .source { color: #777; font-size: 0.85em; margin-top: 2em; border-top: 1px solid #ddd; padding-top: 0.6em; }
</style>
</head>
<body>
<h1>${title}</h1>
${byline}
${article.content}
<p class="source">Source${site ? " · " + site : ""}: <a href="${url}">${url}</a></p>
</body>
</html>`;
}

function sanitizeFilename(name) {
  return (
    String(name || "article")
      .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "article"
  );
}

const BLOCKED = /^(chrome|edge|brave|about|chrome-extension|view-source|devtools):/i;
function isBlockedUrl(url) {
  if (!url) return true;
  if (BLOCKED.test(url)) return true;
  // Extensions cannot script the Chrome Web Store.
  if (/chrome\.google\.com\/webstore|chromewebstore\.google\.com/.test(url)) return true;
  return false;
}

async function handle(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab.");
  if (isBlockedUrl(tab.url)) {
    throw new Error("This page can't be read by extensions. Open a normal article page.");
  }

  const article = await extractArticle(tab.id);
  if (!article) throw new Error("Couldn't find article content on this page.");
  if (article.__error) throw new Error("Extractor error: " + article.__error);

  const html = buildHtml(article);
  const filename = sanitizeFilename(article.title) + ".html";

  if (mode === "download") {
    const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    return { ok: true, title: article.title, message: "Downloaded: " + filename };
  }

  if (mode === "send") {
    const { kindleEmail, backendUrl } = await chrome.storage.sync.get([
      "kindleEmail",
      "backendUrl",
    ]);
    if (!kindleEmail || !backendUrl) {
      throw new Error("Set your Kindle email and backend URL in Options first.");
    }
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: kindleEmail,
        subject: article.title,
        filename,
        html,
        sourceUrl: article.url,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error("Backend " + res.status + ": " + text.slice(0, 300));
    return { ok: true, title: article.title, message: "Sent to " + kindleEmail };
  }

  throw new Error("Unknown mode: " + mode);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg && msg.mode)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
  return true; // keep the message channel open for the async response
});
