# Email relay (Vercel + Gmail SMTP)

A tiny serverless endpoint that takes `{ to, subject, filename, contentBase64, mimeType }`
and emails the article to a Kindle address as an attachment — **sent from your own Gmail**,
so there's no domain to buy or DNS to verify.

This is what makes the extension's "Send to Kindle" button work.

## Deploy

1. **Turn on 2-Step Verification** for your Google account (required for app passwords):
   [myaccount.google.com → Security](https://myaccount.google.com/security).
2. **Generate an App Password** (16 characters) — pick "Mail" / "Other":
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Deploy this folder to Vercel:
   ```bash
   cd backend
   npx vercel        # link/create the project (installs nodemailer)
   npx vercel --prod # deploy
   ```
   (Or import the repo in the Vercel dashboard and set the root directory to `backend`.)
4. In Vercel → Project → Settings → Environment Variables, add:
   - `GMAIL_USER` — your full Gmail address, e.g. `you@gmail.com`
   - `GMAIL_APP_PASSWORD` — the 16-char app password from step 2 (no spaces)

   Then redeploy (`npx vercel --prod`) so the new env vars take effect.
5. Your endpoint URL is `https://<project>.vercel.app/api/send`. Put that in the
   extension's Options page.

## Amazon approved-sender setup (one time)

Amazon only accepts personal documents from approved addresses. Add **`GMAIL_USER`
(your own Gmail address)** to your *Approved Personal Document E-mail List*:
Amazon → Manage Your Content and Devices → Preferences → Personal Document Settings.

## Test from the terminal

```bash
curl -X POST https://<project>.vercel.app/api/send \
  -H 'Content-Type: application/json' \
  -d '{"to":"YOUR_NAME@kindle.com","subject":"Test","filename":"test.html","html":"<h1>Hello Kindle</h1>"}'
```

## Notes

- Gmail's free sending limit (~500 messages/day) is far more than enough.
- The `From` is forced to your authenticated Gmail address — that's exactly the address
  you approve in Amazon, so there's nothing else to match up.
