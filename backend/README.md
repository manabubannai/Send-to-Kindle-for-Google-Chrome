# Email relay (Vercel + Resend)

A tiny serverless endpoint that takes `{ to, subject, filename, html }` and emails the
HTML to a Kindle address as an attachment. This is what makes the extension's
"Send to Kindle" button work — and what lets other people use the extension without
any per-user OAuth (they only enter their Kindle email + approve your sender address).

## Deploy

1. Sign up at [resend.com](https://resend.com) and **verify a domain** (e.g. `mblog.com`).
   Resend walks you through the SPF/DKIM DNS records.
2. Create an API key in Resend.
3. Deploy this folder to Vercel:
   ```bash
   cd backend
   npx vercel        # link/create the project
   npx vercel --prod # deploy
   ```
   (Or import the repo in the Vercel dashboard and set the root directory to `backend`.)
4. In Vercel → Project → Settings → Environment Variables, add:
   - `RESEND_API_KEY` — your Resend key
   - `SEND_FROM` — e.g. `Kindle <kindle@mblog.com>` (must be on the verified domain)
5. Your endpoint URL is `https://<project>.vercel.app/api/send`. Put that in the
   extension's Options page.

## Amazon approved-sender setup (one time)

Amazon only accepts personal documents from approved addresses. Add the **`SEND_FROM`
address** to your *Approved Personal Document E-mail List*:
Amazon → Manage Your Content and Devices → Preferences → Personal Document Settings.

## Test from the terminal

```bash
curl -X POST https://<project>.vercel.app/api/send \
  -H 'Content-Type: application/json' \
  -d '{"to":"YOUR_NAME@kindle.com","subject":"Test","filename":"test.html","html":"<h1>Hello Kindle</h1>"}'
```
