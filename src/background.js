// Service worker: extract article -> resolve & embed images -> self-contained HTML
// (download/preview) or a fully self-contained EPUB (send to Kindle).
//
// Images are the hard part: news sites lazy-load them, so the real URL lives in
// data-src / srcset / <picture><source>, not src. And even with a correct remote
// URL, Amazon's email converter often fails to fetch external images. So we
// resolve the real URLs in the page, fetch the bytes here in the worker (host
// permissions bypass CORS), and ship them embedded — base64 for HTML, real files
// for EPUB. No external dependency: a tiny store-only ZIP writer builds the EPUB.

/* ------------------------------------------------------------------ */
/* In-page extractor (runs in the tab, has DOM access)                 */
/* ------------------------------------------------------------------ */

/** Injected into the page. Resolves lazy images and returns clean XHTML. */
function extractInPage() {
  try {
    if (typeof Readability === "undefined") {
      return { __error: "Readability did not load" };
    }
    const PAGE_URL = location.href;
    const abs = (u) => {
      try {
        return new URL(u, PAGE_URL).href;
      } catch (_e) {
        return "";
      }
    };

    // Pick the best candidate from a srcset string ("u1 320w, u2 640w" / "u 2x").
    function bestFromSrcset(ss) {
      if (!ss) return "";
      let best = "";
      let bestScore = -1;
      ss.split(",").forEach((part) => {
        const seg = part.trim();
        if (!seg) return;
        const sp = seg.split(/\s+/);
        const u = sp[0];
        const d = sp[1];
        let score = 1;
        if (d) {
          if (/w$/.test(d)) score = parseFloat(d);
          else if (/x$/.test(d)) score = parseFloat(d) * 1000;
        }
        if (u && score > bestScore) {
          bestScore = score;
          best = u;
        }
      });
      return best;
    }

    function isPlaceholder(src) {
      if (!src) return true;
      if (/^data:image\/(gif|svg)/i.test(src)) return true;
      if (/(blank|spacer|placeholder|transparent|1x1|pixel)\.(gif|png|webp)/i.test(src)) return true;
      // Common 1x1 base64 gif/png placeholders.
      if (/^data:image\/[^;]+;base64,(R0lGOD|iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB)/.test(src)) return true;
      return false;
    }

    function pickImageUrl(img) {
      const cur = img.getAttribute("src") || "";
      const candidates = [
        isPlaceholder(cur) ? "" : cur,
        img.getAttribute("data-src"),
        img.getAttribute("data-original"),
        img.getAttribute("data-lazy-src"),
        img.getAttribute("data-lazy"),
        img.getAttribute("data-hi-res-src"),
        bestFromSrcset(img.getAttribute("srcset") || ""),
        bestFromSrcset(img.getAttribute("data-srcset") || ""),
        cur, // last resort: whatever was there
      ];
      for (let i = 0; i < candidates.length; i++) {
        if (candidates[i]) return candidates[i];
      }
      return "";
    }

    function fixLazy(root) {
      // <picture>: lift the best <source> into the inner <img> if it lacks one.
      root.querySelectorAll("picture").forEach((pic) => {
        const img = pic.querySelector("img");
        if (!img) return;
        const curr = img.getAttribute("src") || "";
        if (isPlaceholder(curr)) {
          let best = "";
          pic.querySelectorAll("source").forEach((s) => {
            const u = bestFromSrcset(
              s.getAttribute("srcset") || s.getAttribute("data-srcset") || ""
            );
            if (u) best = u;
          });
          if (best) img.setAttribute("src", best);
        }
      });
      root.querySelectorAll("img").forEach((img) => {
        const u = pickImageUrl(img);
        if (u) img.setAttribute("src", u);
      });
    }

    // Parse a clone with lazy images already resolved so Readability keeps them.
    const clone = document.cloneNode(true);
    fixLazy(clone);
    const article = new Readability(clone).parse();
    if (!article) return null;

    // Reparse the extracted content for clean serialization + absolute image URLs.
    const doc = new DOMParser().parseFromString(article.content || "", "text/html");
    fixLazy(doc);
    doc.querySelectorAll("source").forEach((s) => s.remove());

    const images = [];
    const seen = new Set();
    doc.querySelectorAll("img").forEach((img) => {
      const src = abs(img.getAttribute("src") || "");
      if (!src || /^javascript:/i.test(src)) {
        img.remove();
        return;
      }
      img.setAttribute("src", src);
      if (!seen.has(src)) {
        seen.add(src);
        images.push(src);
      }
    });
    doc.querySelectorAll("a[href]").forEach((a) => {
      const h = abs(a.getAttribute("href"));
      if (h) a.setAttribute("href", h);
      else a.removeAttribute("href");
    });

    // Serialize to well-formed XHTML with a safe tag/attribute whitelist.
    const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
    const KEEP_ATTR = { a: ["href"], img: ["src", "alt"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], ol: ["start"] };
    const DROP_TAG = new Set(["script","style","noscript","iframe","object","embed","form","input","button","svg","canvas","video","audio","source","link","meta","head"]);
    const escText = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const escAttr = (t) => escText(t).replace(/"/g, "&quot;");
    function ser(node) {
      let out = "";
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) {
          out += escText(n.nodeValue || "");
          return;
        }
        if (n.nodeType !== 1) return;
        const tag = n.tagName.toLowerCase();
        if (DROP_TAG.has(tag)) return;
        let attrs = "";
        (KEEP_ATTR[tag] || []).forEach((a) => {
          if (n.hasAttribute(a)) attrs += ` ${a}="${escAttr(n.getAttribute(a))}"`;
        });
        if (VOID.has(tag)) out += `<${tag}${attrs}/>`;
        else out += `<${tag}${attrs}>` + ser(n) + `</${tag}>`;
      });
      return out;
    }
    const content = ser(doc.body);

    return {
      title: article.title || document.title || "Untitled",
      byline: article.byline || "",
      siteName: article.siteName || "",
      lang: (document.documentElement.getAttribute("lang") || "en").slice(0, 8) || "en",
      url: PAGE_URL,
      content,
      images,
    };
  } catch (e) {
    return { __error: String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* X (Twitter) thread extractor                                        */
/* ------------------------------------------------------------------ */

// Readability can't parse X: it's a virtualized SPA with no article markup.
// This runs in the (logged-in) tab instead: it auto-scrolls the status page,
// harvesting the author's consecutive posts as they render — X unloads
// offscreen tweets, so each one must be captured while it's in the DOM.
// Returns the same shape as extractInPage so the whole downstream pipeline
// (image fetch -> EPUB -> send) is unchanged.
async function extractXThreadInPage() {
  try {
    const PAGE_URL = location.href;
    const pm = location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!pm) return { __error: "Not an X status page." };
    const threadHandle = pm[1].toLowerCase();
    const focalId = pm[2];

    const esc = (t) =>
      String(t == null ? "" : t)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const abs = (u) => {
      try {
        return new URL(u, PAGE_URL).href;
      } catch (_e) {
        return "";
      }
    };

    // pbs.twimg.com photo URLs carry the size in ?name=; ask for the large one.
    function upgradePhoto(u) {
      try {
        const url = new URL(u);
        if (url.hostname === "pbs.twimg.com" && url.pathname.startsWith("/media/")) {
          url.searchParams.set("name", "large");
        }
        return url.href;
      } catch (_e) {
        return u;
      }
    }

    // Tweet text -> inline HTML: keep links, flatten styling spans, and turn
    // emoji (X renders them as <img>) back into their alt characters.
    function richText(node) {
      let out = "";
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) {
          out += esc(n.nodeValue).replace(/\n/g, "<br/>");
          return;
        }
        if (n.nodeType !== 1) return;
        const tag = n.tagName.toLowerCase();
        if (tag === "img") {
          out += esc(n.getAttribute("alt") || "");
          return;
        }
        if (tag === "br") {
          out += "<br/>";
          return;
        }
        if (tag === "a") {
          const href = abs(n.getAttribute("href") || "");
          const inner = richText(n);
          out += href ? `<a href="${esc(href)}">${inner}</a>` : inner;
          return;
        }
        out += richText(n);
      });
      return out;
    }

    function authorOf(art) {
      const link = art.querySelector('[data-testid="User-Name"] a[href^="/"]');
      if (!link) return { handle: "", name: "" };
      const handle = (link.getAttribute("href") || "")
        .split(/[?#]/)[0]
        .replace(/^\//, "")
        .split("/")[0]
        .toLowerCase();
      return { handle, name: (link.textContent || "").trim() };
    }

    // Non-focal tweets link their relative timestamp to the permalink; the
    // focal tweet may render its time without one (handled by the caller).
    function permalinkOf(art) {
      const t = art.querySelector("a[href*='/status/'] time");
      if (!t) return { id: "", href: "", datetime: "" };
      const a = t.closest("a");
      const href = abs(a.getAttribute("href") || "");
      const m = href.match(/\/status\/(\d+)/);
      return { id: m ? m[1] : "", href, datetime: t.getAttribute("datetime") || "" };
    }

    // A quoted tweet is a nested clickable card with its own author header.
    function quoteRootOf(art) {
      for (const d of art.querySelectorAll('div[role="link"]')) {
        if (d.querySelector('[data-testid="User-Name"]')) return d;
      }
      return null;
    }

    // Photos + video posters inside `scope`, excluding the quote subtree.
    function mediaOf(scope, excludeRoot) {
      const outside = (el) => !excludeRoot || !excludeRoot.contains(el);
      const imgs = [];
      scope
        .querySelectorAll('[data-testid="tweetPhoto"] img, [data-testid^="card."] img')
        .forEach((img) => {
          if (!outside(img)) return;
          let src = img.currentSrc || img.getAttribute("src") || "";
          if (!/^https?:\/\/pbs\.twimg\.com\//.test(src)) return;
          if (/\/profile_images\//.test(src)) return;
          src = upgradePhoto(src);
          if (!imgs.some((i) => i.src === src)) imgs.push({ src, alt: img.getAttribute("alt") || "" });
        });
      const posters = [];
      scope.querySelectorAll("video[poster]").forEach((v) => {
        if (!outside(v)) return;
        const p = abs(v.getAttribute("poster") || "");
        if (p && !posters.includes(p)) posters.push(p);
      });
      return { imgs, posters };
    }

    function textOf(art, excludeRoot) {
      for (const el of art.querySelectorAll('[data-testid="tweetText"]')) {
        if (!excludeRoot || !excludeRoot.contains(el)) return el;
      }
      return null;
    }

    const collected = new Map(); // status id -> record
    let cutoffTop = Infinity; // doc offset where a stranger's reply ended the thread

    // One pass over the currently rendered tweets (visual order, since the
    // virtualized list positions items with transforms, not DOM order).
    function harvest() {
      const arts = [...document.querySelectorAll('article[data-testid="tweet"]')]
        .map((a) => ({ a, top: a.getBoundingClientRect().top + window.scrollY }))
        .sort((x, y) => x.top - y.top);
      let ended = false;
      let lastOwnTop = -Infinity;
      for (const v of collected.values()) if (v.top > lastOwnTop) lastOwnTop = v.top;

      for (const { a: art, top } of arts) {
        const author = authorOf(art);
        if (!author.handle) continue;
        if (author.handle !== threadHandle) {
          // First reply by someone else below the author's posts = thread end.
          if (top > lastOwnTop && lastOwnTop !== -Infinity) {
            ended = true;
            if (top < cutoffTop) cutoffTop = top;
          }
          continue;
        }
        const perma = permalinkOf(art);
        // The focal tweet may lack a permalink anchor; it's the page's own id.
        const id = perma.id || (!collected.has(focalId) ? focalId : "");
        if (!id || collected.has(id)) {
          if (id) collected.get(id).top = top; // layout above may have grown
          continue;
        }
        if (collected.size >= 200) return true; // runaway guard

        const quoteRoot = quoteRootOf(art);
        const textEl = textOf(art, quoteRoot);
        const media = mediaOf(art, quoteRoot);
        let quote = null;
        if (quoteRoot) {
          const qAuthor = authorOf(quoteRoot);
          const qText = textOf(quoteRoot, null);
          const qMedia = mediaOf(quoteRoot, null);
          quote = {
            author: qAuthor.name || qAuthor.handle,
            text: qText ? richText(qText) : "",
            imgs: qMedia.imgs,
            posters: qMedia.posters,
          };
        }
        let datetime = perma.datetime;
        if (!datetime) {
          const t = art.querySelector("time");
          if (t) datetime = t.getAttribute("datetime") || "";
        }
        collected.set(id, {
          id,
          top,
          name: author.name,
          text: textEl ? richText(textEl) : "",
          plain: textEl ? (textEl.textContent || "").trim() : "",
          lang: (textEl && textEl.getAttribute("lang")) || "",
          imgs: media.imgs,
          posters: media.posters,
          quote,
          datetime,
          permalink: perma.href || PAGE_URL,
        });
        if (top > lastOwnTop) lastOwnTop = top;
      }
      return ended;
    }

    // Scroll from the top through the thread, harvesting as tweets render.
    const startY = window.scrollY;
    window.scrollTo(0, 0);
    await sleep(700);
    const deadline = Date.now() + 35000;
    let lastHeight = 0;
    let stableAtBottom = 0;
    let timedOut = true;
    for (let step = 0; step < 120 && Date.now() < deadline; step++) {
      const ended = harvest();
      if (ended && collected.has(focalId)) {
        timedOut = false;
        break;
      }
      const doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 50) {
        if (doc.scrollHeight === lastHeight) {
          if (++stableAtBottom >= 3) {
            timedOut = false;
            break;
          }
        } else {
          stableAtBottom = 0;
        }
        lastHeight = doc.scrollHeight;
      }
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      await sleep(600);
    }
    harvest();
    window.scrollTo(0, startY);

    // Order chronologically (snowflake ids are time-ordered) and drop any of
    // the author's deeper replies harvested past the thread's end.
    const tweets = [...collected.values()]
      .filter((t) => t.top < cutoffTop)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    if (!tweets.length) {
      return {
        __error:
          "No posts found on this X page. Make sure you're logged in and the post is visible, then try again.",
      };
    }

    const displayName = tweets[0].name || "@" + threadHandle;
    const byline = `${displayName} (@${threadHandle})`;

    const images = [];
    const addImg = (src) => {
      if (src && !images.includes(src)) images.push(src);
    };
    const figure = (src, alt) => {
      addImg(src);
      return `<figure><img src="${esc(src)}" alt="${esc(alt)}"/></figure>`;
    };

    const n = tweets.length;
    const sections = tweets.map((t, i) => {
      let s = '<div class="tweet">';
      if (t.text) s += `<p>${t.text}</p>`;
      t.imgs.forEach((im) => (s += figure(im.src, im.alt)));
      t.posters.forEach((p) => {
        addImg(p);
        s += `<figure><img src="${esc(p)}" alt="video"/><figcaption>Video — watch on X</figcaption></figure>`;
      });
      if (t.quote) {
        s += "<blockquote>";
        if (t.quote.author) s += `<p class="byline">${esc(t.quote.author)}</p>`;
        if (t.quote.text) s += `<p>${t.quote.text}</p>`;
        t.quote.imgs.forEach((im) => (s += figure(im.src, im.alt)));
        t.quote.posters.forEach((p) => {
          addImg(p);
          s += `<figure><img src="${esc(p)}" alt="video"/><figcaption>Video — watch on X</figcaption></figure>`;
        });
        s += "</blockquote>";
      }
      let when = "";
      if (t.datetime) {
        const d = new Date(t.datetime);
        if (!isNaN(d)) when = d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      }
      s += `<p class="tweet-meta">${i + 1}/${n}${
        when ? ` · <a href="${esc(t.permalink)}">${esc(when)}</a>` : ""
      }</p>`;
      s += "</div>";
      return s;
    });
    let content = sections.join("<hr/>");
    if (timedOut) {
      content +=
        '<hr/><p class="tweet-meta">Note: the thread may be truncated — extraction hit its time limit before reaching the end.</p>';
    }

    const excerpt = (tweets[0].plain || "").replace(/\s+/g, " ").trim();
    const title =
      (excerpt ? excerpt.slice(0, 70) + (excerpt.length > 70 ? "…" : "") : `Thread by @${threadHandle}`) +
      (n > 1 ? ` (thread, ${n} posts)` : "");

    return {
      title,
      byline,
      siteName: "X (Twitter)",
      lang: (tweets[0].lang || "en").slice(0, 8) || "en",
      url: PAGE_URL,
      content,
      images,
    };
  } catch (e) {
    return { __error: String(e) };
  }
}

const X_STATUS_RE = /^https?:\/\/(?:mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i;

async function extractArticle(tabId, url) {
  if (X_STATUS_RE.test(url || "")) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractXThreadInPage,
    });
    return result;
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/vendor/Readability.js"],
  });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractInPage,
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* Byte utilities: base64, CRC32, store-only ZIP                       */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a store-only (uncompressed) ZIP. EPUB requires mimetype stored & first. */
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = 0x21; // 1980-01-01
  for (const f of files) {
    const nameB = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + nameB.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true); // method: store
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true);
    dv.setUint16(28, 0, true);
    lh.set(nameB, 30);
    chunks.push(lh, data);

    const cd = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameB, 46);
    central.push(cd);
    offset += lh.length + data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  central.forEach((c) => (centralSize += c.length));
  central.forEach((c) => chunks.push(c));

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  chunks.push(eocd);

  let total = 0;
  chunks.forEach((c) => (total += c.length));
  const out = new Uint8Array(total);
  let p = 0;
  chunks.forEach((c) => {
    out.set(c, p);
    p += c.length;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Image fetching                                                      */
/* ------------------------------------------------------------------ */

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

function extForMime(mime, url) {
  const m = (mime || "").split(";")[0].trim().toLowerCase();
  if (MIME_EXT[m]) return { mime: m, ext: MIME_EXT[m] };
  const um = (url.match(/\.(jpe?g|png|gif|webp|bmp|svg)(?:[?#]|$)/i) || [])[1];
  if (um) {
    const e = um.toLowerCase() === "jpeg" ? "jpg" : um.toLowerCase();
    const back = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };
    return { mime: back[e], ext: e };
  }
  return { mime: "image/jpeg", ext: "jpg" };
}

// Two image problems to solve:
//  1) Kindle's EPUB converter can't render WebP/AVIF (shows an empty placeholder).
//  2) Vercel caps the relay request body at ~4.5MB, so full-resolution images make
//     large articles fail to send ("FUNCTION_PAYLOAD_TOO_LARGE" / 413).
// So we re-encode every raster image to JPEG at a capped size. For sending we shrink
// progressively until the whole set fits a byte budget (see encodeImagesWithinBudget).
// Uses createImageBitmap + OffscreenCanvas (both available in an MV3 service worker).
const MAX_IMAGE_SIDE = 1600; // default longest-side cap; plenty for Kindle screens
const JPEG_QUALITY = 0.75;
// Progressive fallbacks [longest side, JPEG quality] for image-heavy articles.
const ENCODE_LEVELS = [
  [1600, 0.75],
  [1200, 0.65],
  [950, 0.55],
  [750, 0.48],
  [600, 0.45],
  [500, 0.4],
];

// Re-encode one image to JPEG at the given size/quality. GIFs pass through untouched.
async function encodeImage(raw, mime, ext, maxSide, quality) {
  if (/^gif$/i.test(ext)) return { bytes: raw, mime, ext };
  try {
    const bmp = await createImageBitmap(new Blob([raw], { type: mime }));
    const ms = Math.max(bmp.width, bmp.height);
    const scale = Math.min(1, maxSide / ms);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // flatten any transparency onto white for JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const out = new Uint8Array(await blob.arrayBuffer());
    if (out.length) return { bytes: out, mime: "image/jpeg", ext: "jpg" };
  } catch (_e) {
    /* fall through and ship the original bytes */
  }
  return { bytes: raw, mime, ext };
}

// Encode every fetched image at one level; assigns bytes/mime/ext/name on each map
// entry and returns the total encoded image byte size.
async function encodeImagesAtLevel(map, maxSide, quality) {
  let total = 0;
  let n = 0;
  for (const info of map.values()) {
    if (!info.ok) continue;
    const r = await encodeImage(info.raw, info.rawMime, info.rawExt, maxSide, quality);
    info.bytes = r.bytes;
    info.mime = r.mime;
    info.ext = r.ext;
    n++;
    info.name = `images/img${n}.${r.ext}`;
    total += r.bytes.length;
  }
  return total;
}

// For sending: shrink images progressively until they fit the byte budget.
// If even the smallest level is over budget, drop the largest images until it
// fits: an article with a few photos missing beats the whole send failing over
// to a local file the user has to upload by hand.
async function encodeImagesWithinBudget(map, budgetBytes) {
  let total = 0;
  for (const [maxSide, quality] of ENCODE_LEVELS) {
    total = await encodeImagesAtLevel(map, maxSide, quality);
    if (total <= budgetBytes) return { total, dropped: 0 };
  }
  const bySize = [...map.values()]
    .filter((i) => i.ok)
    .sort((a, b) => b.bytes.length - a.bytes.length);
  let dropped = 0;
  for (const info of bySize) {
    if (total <= budgetBytes) break;
    info.ok = false; // rewriteImgs/buildEpub treat it like a failed fetch
    total -= info.bytes.length;
    dropped++;
  }
  return { total, dropped };
}

// Fetch raw image bytes only; encoding/resizing happens later (size-budget aware).
async function fetchImage(url) {
  if (/^data:/i.test(url)) {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
    if (!m) return { url, ok: false };
    const mime = m[1] || "image/png";
    const isB64 = !!m[2];
    try {
      const raw = isB64 ? base64ToBytes(m[3]) : enc.encode(decodeURIComponent(m[3]));
      const { mime: rawMime, ext: rawExt } = extForMime(mime, url);
      return { url, ok: true, raw, rawMime, rawExt };
    } catch (_e) {
      return { url, ok: false };
    }
  }
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { signal: ctrl.signal, credentials: "omit" });
    clearTimeout(to);
    if (!res.ok) return { url, ok: false };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length || buf.length > 12 * 1024 * 1024) return { url, ok: false };
    const { mime: rawMime, ext: rawExt } = extForMime(res.headers.get("content-type"), url);
    return { url, ok: true, raw: buf, rawMime, rawExt };
  } catch (_e) {
    return { url, ok: false };
  }
}

async function fetchImages(urls) {
  const map = new Map();
  const list = (urls || []).slice(0, 60);
  const results = await Promise.all(list.map(fetchImage));
  for (const r of results) map.set(r.url, r);
  return map;
}

/* ------------------------------------------------------------------ */
/* Document assembly                                                   */
/* ------------------------------------------------------------------ */

const CSS =
  'body{font-family:Georgia,"Times New Roman",serif;line-height:1.6;max-width:40em;margin:0 auto;padding:1.2em}' +
  "h1{font-size:1.6em;line-height:1.25}img{max-width:100%;height:auto}figure{margin:1em 0}" +
  "figcaption{color:#666;font-size:.85em}blockquote{border-left:3px solid #ccc;margin:1em 0;padding-left:1em;color:#444}" +
  "pre{white-space:pre-wrap;word-wrap:break-word}.byline{color:#555;font-style:italic;margin-top:0}" +
  ".source{color:#777;font-size:.85em;margin-top:2em;border-top:1px solid #ddd;padding-top:.6em}" +
  "hr{border:none;border-top:1px solid #ddd;margin:1.4em 0}" +
  ".tweet-meta{color:#888;font-size:.8em;margin-top:.4em}";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const xmlEsc = (s) =>
  String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// The in-page serializer entity-escapes attribute values; reverse it to recover the
// raw URL used as the image-map key (CDN URLs commonly contain & -> &amp;).
const htmlUnescape = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Rewrite <img> tags via toRef(info)->src; drop images that failed to fetch. */
function rewriteImgs(content, map, toRef) {
  return content.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/\bsrc="([^"]*)"/i);
    const url = m ? htmlUnescape(m[1]) : "";
    const info = map.get(url);
    if (!info || !info.ok) return "";
    const ref = toRef(info);
    if (!ref) return "";
    const am = tag.match(/\balt="([^"]*)"/i);
    const alt = am ? am[1] : "";
    return `<img src="${ref}" alt="${alt}"/>`;
  });
}

function buildSelfContainedHtml(article, map) {
  const body = rewriteImgs(article.content, map, (info) => `data:${info.mime};base64,${bytesToBase64(info.bytes)}`);
  const t = escapeHtml(article.title);
  const byline = article.byline ? `<p class="byline">${escapeHtml(article.byline)}</p>` : "";
  const site = article.siteName ? " · " + escapeHtml(article.siteName) : "";
  const url = escapeHtml(article.url);
  const lang = escapeHtml(article.lang || "en");
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>${CSS}</style>
</head>
<body>
<h1>${t}</h1>
${byline}
${body}
<p class="source">Source${site}: <a href="${url}">${url}</a></p>
</body>
</html>`;
}

function buildEpub(article, map) {
  const body = rewriteImgs(article.content, map, (info) => info.name);
  const used = [...map.values()].filter((i) => i.ok && i.name && body.includes(`"${i.name}"`));

  const t = xmlEsc(article.title);
  const lang = xmlEsc(article.lang || "en");
  const creator = xmlEsc(article.byline || article.siteName || "");
  const byline = article.byline ? `<p class="byline">${xmlEsc(article.byline)}</p>` : "";
  const site = article.siteName ? " · " + xmlEsc(article.siteName) : "";
  const url = xmlEsc(article.url);
  const uuid = (self.crypto && crypto.randomUUID && crypto.randomUUID()) || "import-" + crc32(enc.encode(article.url + article.title));

  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" lang="${lang}">
<head>
<meta charset="utf-8"/>
<title>${t}</title>
<style>${CSS}</style>
</head>
<body>
<h1>${t}</h1>
${byline}
${body}
<p class="source">Source${site}: <a href="${url}">${url}</a></p>
</body>
</html>`;

  const manifestItems = [
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>',
  ];
  const zipFiles = [
    { name: "mimetype", data: enc.encode("application/epub+zip") },
    {
      name: "META-INF/container.xml",
      data: enc.encode(
        '<?xml version="1.0" encoding="utf-8"?>\n' +
          '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
          '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n' +
          "</container>"
      ),
    },
  ];
  used.forEach((info, i) => {
    const id = `img${i + 1}`;
    manifestItems.push(`<item id="${id}" href="${info.name}" media-type="${info.mime}"/>`);
    zipFiles.push({ name: `OEBPS/${info.name}`, data: info.bytes });
  });

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:title>${t}</dc:title>
<dc:language>${lang}</dc:language>
<dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
${creator ? `<dc:creator>${creator}</dc:creator>\n` : ""}<dc:source>${url}</dc:source>
</metadata>
<manifest>
${manifestItems.join("\n")}
</manifest>
<spine toc="ncx">
<itemref idref="content"/>
</spine>
</package>`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:${uuid}"/></head>
<docTitle><text>${t}</text></docTitle>
<navMap><navPoint id="np1" playOrder="1"><navLabel><text>${t}</text></navLabel><content src="content.xhtml"/></navPoint></navMap>
</ncx>`;

  zipFiles.push({ name: "OEBPS/content.opf", data: enc.encode(opf) });
  zipFiles.push({ name: "OEBPS/toc.ncx", data: enc.encode(ncx) });
  zipFiles.push({ name: "OEBPS/content.xhtml", data: enc.encode(xhtml) });

  return { bytes: zipStore(zipFiles), imageCount: used.length };
}

/* ------------------------------------------------------------------ */
/* Job tracking: storage.session registry + badge + notifications      */
/* ------------------------------------------------------------------ */

// Sends are tracked as jobs that outlive the popup: the popup only enqueues,
// then the worker extracts/builds/sends and records progress in
// chrome.storage.session. Failures surface three ways so batch sends from many
// tabs can't fail silently: an OS notification (click = jump to the tab), a red
// count on the toolbar badge that persists until reviewed, and the popup's
// activity list.

const MAX_JOBS = 30;
const BADGE_COLOR = { error: "#d93025", running: "#1a73e8", ok: "#188038" };

// All read-modify-write cycles on the job list go through one promise chain:
// concurrent jobs finish in any order, and parallel get/set pairs on
// storage.session would drop updates. Side effects that must happen in commit
// order (keepalive/watchdog flips) run inside the fn, in-turn.
let jobsChain = Promise.resolve();
function withJobs(fn) {
  const next = jobsChain.then(async () => {
    const { jobs = [] } = await chrome.storage.session.get("jobs");
    const out = fn(jobs) || jobs;
    // Cap history without ever evicting a running job: updateJob writes, the
    // batch-drained check, the reaper, dedupe, and notification click-through
    // all require in-flight jobs to stay in storage (a 31+ tab batch would
    // otherwise silently lose its oldest send).
    let finished = 0;
    const capped = out.filter((j) => j.status === "running" || ++finished <= MAX_JOBS);
    await chrome.storage.session.set({ jobs: capped });
    return capped;
  });
  jobsChain = next.catch(() => {}); // keep the chain usable after a failure
  return next;
}

async function updateJob(id, patch) {
  const jobs = await withJobs((jobs) => {
    const j = jobs.find((j) => j.id === id);
    if (j) Object.assign(j, patch);
    return jobs;
  });
  await refreshBadge(jobs);
  return jobs;
}

const isProblem = (j) => j.status === "error" || j.status === "warn";

let clearBadgeTimer = null;

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (text) {
    await chrome.action.setBadgeBackgroundColor({ color });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    }
  }
}

// Unseen failures (red) win over in-flight count (blue); otherwise clear.
// The transient green ✓ after an all-ok batch is set directly by runJob.
async function refreshBadge(jobs) {
  if (!jobs) jobs = (await chrome.storage.session.get("jobs")).jobs || [];
  if (clearBadgeTimer) {
    clearTimeout(clearBadgeTimer);
    clearBadgeTimer = null;
  }
  const unseen = jobs.filter((j) => isProblem(j) && !j.seen).length;
  const running = jobs.filter((j) => j.status === "running").length;
  if (unseen > 0) await setBadge(String(unseen), BADGE_COLOR.error);
  else if (running > 0) await setBadge(String(running), BADGE_COLOR.running);
  else await setBadge("", BADGE_COLOR.ok);
}

function notify(id, title, message, { sticky = false } = {}) {
  try {
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      priority: 2,
      requireInteraction: sticky,
    });
  } catch (_e) {
    /* notifications may be blocked at the OS level; badge still shows it */
  }
}

// Clicking a job notification acknowledges the failure (clears its share of
// the red badge) and jumps to the tab it came from.
chrome.notifications.onClicked.addListener(async (nid) => {
  chrome.notifications.clear(nid);
  if (!nid.startsWith("job-")) return;
  const id = nid.slice("job-".length);
  const jobs = await updateJob(id, { seen: true }); // also recomputes the badge
  const job = jobs.find((j) => j.id === id);
  if (!job || !job.tabId) return;
  try {
    const tab = await chrome.tabs.get(job.tabId);
    await chrome.tabs.update(job.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_e) {
    /* tab was closed since */
  }
});

// MV3 idle-kills the worker after ~30s without extension API activity; a long
// backend POST could cross that line. Any API call resets the timer, so tick
// one while jobs are in flight.
let keepaliveTimer = null;
function setKeepalive(on) {
  if (on && !keepaliveTimer) {
    keepaliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  } else if (!on && keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// Batch bookkeeping for the "all N sent" summary + green ✓. In-memory only:
// if the worker dies mid-batch there is simply no summary — per-job failure
// notifications (the critical path) come from storage, not from this.
let batch = { ok: 0, problems: 0 };

// Number of runJob() calls alive in THIS worker instance. If an alarm fires
// and this is 0 but storage still has "running" jobs, the worker that owned
// them was killed — surface those as interrupted instead of spinning forever.
let activeRuns = 0;

const WATCHDOG = "job-watchdog";

let jobSeq = 0;
const newJobId = () =>
  Date.now().toString(36) + "-" + ++jobSeq + "-" + Math.random().toString(36).slice(2, 6);

async function enqueueJob(mode, tab) {
  const job = {
    id: newJobId(),
    mode,
    tabId: tab.id,
    title: tab.title || tab.url || "Untitled",
    url: tab.url || "",
    status: "running",
    message: "Queued…",
    startedAt: Date.now(),
    seen: false,
  };
  let existing = null;
  const jobs = await withJobs((jobs) => {
    existing = jobs.find((j) => j.status === "running" && j.tabId === tab.id && j.mode === mode);
    if (existing) return jobs; // double-click guard: this tab is already in flight
    if (!jobs.some((j) => j.status === "running")) batch = { ok: 0, problems: 0 };
    jobs.unshift(job);
    // In-turn: a completion turn racing this enqueue would otherwise flip
    // keepalive/watchdog off AFTER we flipped them on.
    setKeepalive(true);
    chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
    return jobs;
  });
  if (existing) return existing.id;
  await refreshBadge(jobs);
  runJob(job, mode, tab); // deliberately not awaited: the popup returns immediately
  return job.id;
}

async function runJob(job, mode, tab) {
  // activeRuns stays high until the final status is WRITTEN, so the watchdog
  // can never observe "no active runs" while this job still looks running.
  activeRuns++;
  let jobs;
  let result;
  let anyRunning = true;
  let anyUnseenProblem = false;
  let batchSnap = { ok: 0, problems: 0 };
  try {
    const progress = (message) => {
      updateJob(job.id, { message }).catch(() => {});
    };
    try {
      result = await handle(mode, tab, progress);
    } catch (e) {
      let message = String((e && e.message) || e);
      if (/no tab with id|tab was closed|frame .*removed/i.test(message)) {
        message = "The tab was closed before the article could be read.";
      }
      result = { ok: false, message };
    }
    const status = result.ok ? (result.warn ? "warn" : "ok") : "error";
    result.status = status;
    // One serialized turn writes the final status, updates the batch counters,
    // and decides whether the batch just drained. A racing enqueue chains
    // after this turn, so the keepalive/watchdog flips happen in commit order
    // and the "all done" verdict can't be based on a stale snapshot.
    jobs = await withJobs((jobs) => {
      const j = jobs.find((x) => x.id === job.id);
      if (j) {
        Object.assign(j, {
          status,
          message: result.message,
          title: result.title || job.title,
          finishedAt: Date.now(),
        });
      }
      if (status === "ok") batch.ok++;
      else batch.problems++;
      anyRunning = jobs.some((x) => x.status === "running");
      anyUnseenProblem = jobs.some((x) => isProblem(x) && !x.seen);
      batchSnap = { ...batch };
      if (!anyRunning) {
        setKeepalive(false);
        chrome.alarms.clear(WATCHDOG);
      }
      return jobs;
    });
  } finally {
    activeRuns--;
  }
  await refreshBadge(jobs);

  const status = result.status;
  const title = result.title || job.title;
  if (status === "error") {
    notify("job-" + job.id, "Send to Kindle failed", `${title}\n${result.message}`, { sticky: true });
  } else if (status === "warn") {
    notify("job-" + job.id, "Send to Kindle — action needed", `${title}\n${result.message}`, { sticky: true });
  }

  if (!anyRunning && batchSnap.problems === 0 && batchSnap.ok > 0 && !anyUnseenProblem) {
    if (batchSnap.ok > 1) {
      notify("batch-" + job.id, "Sent to Kindle", `All ${batchSnap.ok} articles sent successfully.`);
    }
    await setBadge("✓", BADGE_COLOR.ok); // transient; cleared below
    clearBadgeTimer = setTimeout(() => refreshBadge().catch(() => {}), 8000);
  }
}

async function markSeen() {
  const jobs = await withJobs((jobs) => {
    jobs.forEach((j) => {
      if (j.status !== "running") j.seen = true;
    });
    return jobs;
  });
  await refreshBadge(jobs);
}

async function clearHistory() {
  const jobs = await withJobs((jobs) => jobs.filter((j) => j.status === "running"));
  chrome.notifications.getAll((all) => {
    for (const id of Object.keys(all || {})) {
      if (id.startsWith("job-") || id.startsWith("batch-")) chrome.notifications.clear(id);
    }
  });
  await refreshBadge(jobs);
}

// Jobs still marked "running" in storage that this worker instance doesn't own
// are dead (their worker was killed) — surface them instead of leaving them
// spinning forever. `minAgeMs` guards the watchdog against reaping a job that
// was enqueued moments ago but whose runJob hasn't been observed yet.
async function reapInterruptedJobs(minAgeMs = 0, clearAlarmIfIdle = false) {
  const cutoff = Date.now() - minAgeMs;
  let reaped = 0;
  const jobs = await withJobs((jobs) => {
    jobs.forEach((j) => {
      if (j.status === "running" && j.startedAt <= cutoff) {
        j.status = "error";
        j.message = "Interrupted — Chrome suspended the extension mid-send. Please retry.";
        j.finishedAt = Date.now();
        j.seen = false;
        reaped++;
      }
    });
    // In-turn like the other flips: never undo what a racing enqueue just set
    // up for its own job. Keepalive must also drop here, or a job orphaned by
    // a failed storage write would pin this worker alive forever.
    if (!jobs.some((j) => j.status === "running")) {
      setKeepalive(false);
      if (clearAlarmIfIdle) chrome.alarms.clear(WATCHDOG);
    }
    return jobs;
  });
  await refreshBadge(jobs);
  if (reaped > 0) {
    notify(
      "reaped-" + Date.now(),
      "Send to Kindle interrupted",
      `${reaped} send${reaped === 1 ? " was" : "s were"} interrupted before finishing. Open the extension to see which, then retry.`,
      { sticky: true }
    );
  }
  return jobs;
}
reapInterruptedJobs();

// Watchdog: fires every minute while jobs are (supposedly) in flight. If this
// worker owns no active runs, whatever storage says is "running" is orphaned —
// the alarm both wakes a fresh worker after a kill and cleans up here.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG) return;
  if (activeRuns > 0) return; // jobs genuinely alive in this instance
  await reapInterruptedJobs(60 * 1000, true);
});

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

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
  if (/chrome\.google\.com\/webstore|chromewebstore\.google\.com/.test(url)) return true;
  return false;
}

async function handle(mode, tab, progress = () => {}) {
  if (!tab || !tab.id) throw new Error("No active tab.");
  if (isBlockedUrl(tab.url)) {
    throw new Error("This page can't be read by extensions. Open a normal article page.");
  }

  const isXThread = X_STATUS_RE.test(tab.url || "");
  progress(isXThread ? "Reading X thread (auto-scrolling)…" : "Extracting article…");
  const article = await extractArticle(tab.id, tab.url);
  if (!article) throw new Error("Couldn't find article content on this page.");
  if (article.__error) throw new Error("Extractor error: " + article.__error);

  const nImgs = (article.images || []).length;
  progress(nImgs ? `Fetching ${nImgs} image${nImgs === 1 ? "" : "s"}…` : "Preparing…");
  const imgMap = await fetchImages(article.images);
  const okCount = [...imgMap.values()].filter((i) => i.ok).length;
  const imgNote = `${okCount} image${okCount === 1 ? "" : "s"}`;

  if (mode === "download") {
    progress("Building HTML…");
    await encodeImagesAtLevel(imgMap, MAX_IMAGE_SIDE, JPEG_QUALITY);
    const html = buildSelfContainedHtml(article, imgMap);
    const filename = sanitizeFilename(article.title) + ".html";
    const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    return { ok: true, title: article.title, message: `Downloaded: ${filename} (${imgNote})` };
  }

  if (mode === "send") {
    const { kindleEmail, backendUrl } = await chrome.storage.sync.get(["kindleEmail", "backendUrl"]);
    if (!kindleEmail || !backendUrl) {
      throw new Error("Set your Kindle email and backend URL in Options first.");
    }
    // Shrink images until they fit the relay budget (base64 body must stay < ~4.5MB).
    progress("Building EPUB…");
    // 2.8MB images + article text keeps the base64 body safely under ~4.4MB.
    const { dropped } = await encodeImagesWithinBudget(imgMap, 2.8 * 1024 * 1024);
    const { bytes, imageCount } = buildEpub(article, imgMap);
    const filename = sanitizeFilename(article.title) + ".epub";
    const contentBase64 = bytesToBase64(bytes);

    // Hard guard: Vercel rejects request bodies over ~4.5MB. If even the shrunk EPUB
    // is too big, save it locally and tell the user to upload via Amazon (no size cap).
    if (contentBase64.length > 4.4 * 1024 * 1024) {
      const epubDataUrl = `data:application/epub+zip;base64,${contentBase64}`;
      await chrome.downloads.download({ url: epubDataUrl, filename, saveAs: false });
      const mb = Math.round((bytes.length / 1024 / 1024) * 10) / 10;
      return {
        ok: true,
        warn: true,
        title: article.title,
        message: `Too large to email (${mb}MB). Saved ${filename} — upload it at amazon.com/sendtokindle.`,
      };
    }

    progress("Sending to Kindle…");
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 90000);
    let res;
    try {
      res = await fetch(backendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: kindleEmail,
          subject: article.title,
          filename,
          contentBase64,
          mimeType: "application/epub+zip",
          sourceUrl: article.url,
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(
        ctrl.signal.aborted
          ? "Send timed out after 90s — backend unreachable?"
          : "Network error contacting backend: " + String((e && e.message) || e)
      );
    } finally {
      clearTimeout(to);
    }
    const text = await res.text();
    if (!res.ok) throw new Error("Backend " + res.status + ": " + text.slice(0, 300));
    const droppedNote = dropped
      ? `, ${dropped} large image${dropped === 1 ? "" : "s"} skipped to fit the size limit`
      : "";
    return {
      ok: true,
      title: article.title,
      message: `Sent to ${kindleEmail} (${imageCount} embedded${droppedNote})`,
    };
  }

  throw new Error("Unknown mode: " + mode);
}

/* ------------------------------------------------------------------ */
/* Messages from the popup                                             */
/* ------------------------------------------------------------------ */

// enqueue: validate what the user can fix right now (blocked page, missing
// options) and answer immediately so the popup can show it inline; everything
// slower runs as a tracked job and reports via badge/notifications/history.
async function onMessage(msg) {
  if (!msg || typeof msg !== "object") throw new Error("Bad message.");

  if (msg.type === "enqueue") {
    const { mode, tab } = msg;
    if (!tab || !tab.id) throw new Error("No active tab.");
    if (isBlockedUrl(tab.url)) {
      throw new Error("This page can't be read by extensions. Open a normal article page.");
    }
    if (mode === "send") {
      const { kindleEmail, backendUrl } = await chrome.storage.sync.get(["kindleEmail", "backendUrl"]);
      if (!kindleEmail || !backendUrl) {
        throw new Error("Set your Kindle email and backend URL in Options first.");
      }
    }
    const jobId = await enqueueJob(mode, tab);
    return { ok: true, jobId };
  }

  if (msg.type === "markSeen") {
    await markSeen();
    return { ok: true };
  }

  // Sent by the popup on open purely to wake this worker so the cold-start
  // reaper can flag any orphaned "running" jobs right away.
  if (msg.type === "wake") {
    return { ok: true };
  }

  if (msg.type === "clearHistory") {
    await clearHistory();
    return { ok: true };
  }

  throw new Error("Unknown message type: " + msg.type);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  onMessage(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
  return true; // keep the message channel open for the async response
});
