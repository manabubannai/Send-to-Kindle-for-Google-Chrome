// Vercel serverless function: relays an article to a Kindle email as an attachment.
// Sends from your own Gmail via SMTP (nodemailer) — no domain / DNS verification.
//
// Required env vars:
//   GMAIL_USER          - your full Gmail address (e.g. you@gmail.com).
//                         This exact address must be on your Amazon "Approved
//                         Personal Document E-mail List".
//   GMAIL_APP_PASSWORD  - a 16-char Google App Password (NOT your normal password):
//                         https://myaccount.google.com/apppasswords  (needs 2FA on).

import nodemailer from "nodemailer";

export default async function handler(req, res) {
  // CORS (harmless; extension requests are already allowed via host_permissions).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { to, subject, filename, html, contentBase64, mimeType } = req.body || {};
    if (!to) return res.status(400).json({ error: "Missing 'to'." });

    // Accept either a pre-built base64 attachment (EPUB) or raw HTML (legacy).
    let buffer;
    let fname;
    let contentType;
    if (contentBase64) {
      buffer = Buffer.from(contentBase64, "base64");
      fname = filename || "article.epub";
      contentType = mimeType || "application/epub+zip";
    } else if (html) {
      buffer = Buffer.from(html, "utf-8");
      fname = filename || "article.html";
      contentType = "text/html";
    } else {
      return res.status(400).json({ error: "Missing 'contentBase64' or 'html'." });
    }

    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) {
      return res.status(500).json({ error: "Server not configured (GMAIL_USER / GMAIL_APP_PASSWORD)." });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });

    const info = await transporter.sendMail({
      from: `Send to Kindle <${user}>`,
      to,
      subject: subject || "Article",
      text: "Sent to Kindle by the Send to Kindle (Reader) extension.",
      attachments: [{ filename: fname, content: buffer, contentType }],
    });

    return res.status(200).json({ ok: true, id: info.messageId });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
