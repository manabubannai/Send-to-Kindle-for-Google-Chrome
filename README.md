# Send to Kindle (Reader)

A working alternative to the official "Send to Kindle for Google Chrome" extension,
which breaks because it depends on Amazon's authenticated web endpoints (CORB/CORS
issues under Manifest V3, and frequent backend changes).

This one uses the **stable, documented email method** instead: it extracts the article
on the page with Mozilla Readability, builds a clean HTML document, and emails it to
your `@kindle.com` address.

## Architecture

```
Chrome tab
  └─ Extension (MV3): popup button
        ├─ Readability extracts the article  (src/vendor/Readability.js + src/background.js)
        ├─ Builds clean HTML
        └─ "Download HTML"  → saves locally (no setup)
           "Send to Kindle" → POSTs to your relay → Resend emails it to @kindle.com
                               (backend/api/send.js on Vercel)
```

One architecture serves both **personal use today** and **distribution later**:
other users never need OAuth — they just enter their Kindle email and add your relay's
sender address to Amazon's approved list.

## Quick start (personal, today)

### 1. Load the extension
1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (`send-to-kindle/`).
3. Pin it. Open any article and click the toolbar icon → **Download HTML**.
4. Email that file once to your `@kindle.com` address to confirm it renders well on Kindle.
   (This validates conversion quality before wiring up automatic sending.)

### 2. Stand up the relay (one-click sending)
See [`backend/README.md`](backend/README.md): deploy to Vercel, set `RESEND_API_KEY`
and `SEND_FROM`, and add `SEND_FROM` to your Amazon Approved Personal Document E-mail List.

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
- [x] Download HTML (zero-setup)
- [x] One-click send via Vercel + Resend relay
- [ ] EPUB output with inlined images (better fidelity than HTML)
- [ ] Toolbar icons + nicer popup
- [ ] Multi-tab "bundle into one ebook"
- [ ] Chrome Web Store packaging (for public distribution)

Supported Kindle formats via email: PDF, DOC(X), TXT, RTF, HTM/HTML, PNG/JPG/GIF/BMP,
EPUB. 50 MB per email.
