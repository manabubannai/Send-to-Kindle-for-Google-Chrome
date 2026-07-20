# Send to Kindle (Reader)

> 📖 **はじめての方は [SETUP.md（日本語セットアップ手順）](SETUP.md) を見てください。** 約15分・無料で設定できます。

A working alternative to the official "Send to Kindle for Google Chrome" extension,
which breaks because it depends on Amazon's authenticated web endpoints (CORB/CORS
issues under Manifest V3, and frequent backend changes).

This one uses the **stable, documented email method** instead: it extracts the article
on the page with Mozilla Readability, **embeds every image into a self-contained file**,
and emails it to your `@kindle.com` address.

### Why images need special handling

News sites lazy-load images, so the real URL lives in `data-src` / `srcset` /
`<picture><source>`, not `src` — a naïve extraction ships broken `?` boxes. And even
with correct remote URLs, Amazon's email converter often fails to fetch external images.
So the extension:

1. Resolves the real image URLs in the page (de-lazies `data-src`/`srcset`/`<picture>`).
2. Fetches the bytes in the service worker (host permissions bypass CORS).
3. Embeds them — **base64-inline** for the HTML preview, **real files inside an EPUB**
   for sending (the format Amazon converts most reliably).

The EPUB is built by a tiny dependency-free store-only ZIP writer (no JSZip).

## Architecture

```
Chrome tab
  └─ Extension (MV3): one tap on the toolbar icon
        ├─ Readability extracts the article  (src/vendor/Readability.js + src/background.js)
        ├─ Resolves lazy images → fetches bytes → embeds them
        └─ builds EPUB w/ embedded images → POSTs to your relay
           → relay emails it to @kindle.com from your Gmail (backend/api/send.js)
```

### One-tap batch sending & error visibility

**Opening the popup IS the send**: the moment you tap the toolbar icon, the current
tab is queued as a **background job** — close the popup immediately, open the next
tab, tap again. Two guards prevent accidental sends when you only meant to check
history: a page already sent in the last 3 minutes, or unreviewed failures (red
badge), switch the popup to view mode with an explicit send button. You can't miss
a failure:

- **OS notification** on every failed send (and on "file too large, saved locally —
  upload manually"). Clicking the notification jumps back to the offending tab.
- **Toolbar badge**: blue count while sends are in flight, **red count of failures**
  that stays until you open the popup and see them, green ✓ when a batch finishes clean.
- **Activity list in the popup**: live status (extracting / fetching images / sending)
  and the last 30 results with error reasons.
- A batch that finishes with no failures shows one "All N articles sent" notification
  instead of per-article noise.
- A watchdog alarm catches the rare case where Chrome kills the service worker
  mid-send: within a minute the orphaned job is flagged "Interrupted" and notified,
  instead of spinning forever.

Jobs are also bound to the tab you clicked from, so switching tabs mid-send can never
extract the wrong page.

One architecture serves both **personal use today** and **distribution later**:
other users never need OAuth — they just enter their Kindle email and add your relay's
sender address to Amazon's approved list.

## Quick start (personal, today)

### 1. Load the extension
1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (`send-to-kindle/`).
3. Pin it. Once Options are configured (steps below), opening any article and
   tapping the icon sends it — no further clicks.

> On load, Chrome will warn that the extension can "read your data on all websites".
> That broad host permission is only used to **fetch article images** from any site so
> they can be embedded; there is no tracking or external reporting.

### 2. Stand up the relay (one-click sending)
See [`backend/README.md`](backend/README.md): deploy to Vercel, set `GMAIL_USER`
and a `GMAIL_APP_PASSWORD`, and add your Gmail address to your Amazon Approved Personal
Document E-mail List. No domain or DNS needed — it sends from your own Gmail.

### 3. Configure & send
Open the extension's **Options**, paste your Kindle email and the relay URL, Save.
Now **Send to Kindle** delivers in one click.

## Why the email method (not the official approach)

| | Official extension | This extension |
|---|---|---|
| Mechanism | Amazon authenticated web API | `@kindle.com` email (documented) |
| Breaks when Amazon changes endpoints | Yes | No |
| CORB/CORS issues under MV3 | Yes | No |
| Distribution to others | n/a | No per-user OAuth needed |

## Status / roadmap

- [x] Article extraction (Readability) + clean HTML
- [x] Lazy-image resolution (`data-src`/`srcset`/`<picture>`) + embedding
- [x] Transcode WebP/AVIF → JPEG (Kindle's EPUB converter can't render WebP)
- [x] Resize/recompress images (cap 1600px, JPEG q0.75) to stay under Vercel's 4.5MB relay limit
- [x] Image-heavy articles: shrink progressively to a byte budget, then drop the largest images to fit; the local-EPUB-download fallback (upload via Amazon) remains only as a last resort
- [x] EPUB output with embedded image files (sent to Kindle)
- [x] One-click send via Vercel + Gmail SMTP relay (no domain/DNS)
- [x] Background jobs: popup-independent sends, OS notifications on failure, badge counts, activity history (batch-safe)
- [x] Toolbar icons + nicer popup
- [x] One-tap send: opening the popup auto-sends the current tab (Download HTML UI removed in 0.4.0; the code path remains in background.js)
- [x] X (Twitter) threads: on a `x.com/*/status/*` page, a dedicated extractor auto-scrolls
  the thread (the timeline is virtualized, so offscreen tweets leave the DOM), collects the
  author's consecutive posts — text, photos upgraded to `name=large`, quoted tweets, video
  thumbnails — and sends them as one numbered EPUB. Runs in your logged-in tab, so no X API
  is needed. Stops at the first reply by someone else.
- [ ] Multi-tab "bundle into one ebook"
- [ ] Chrome Web Store packaging (for public distribution)

Supported Kindle formats via email: PDF, DOC(X), TXT, RTF, HTM/HTML, PNG/JPG/GIF/BMP,
EPUB. 50 MB per email.
