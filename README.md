# Social Poster

Your own social media poster, like Hootsuite but simpler: write posts once, keep them in a **queue**, and publish with one click to X, Instagram, Facebook Pages, LinkedIn, Threads, Bluesky, Mastodon, Telegram and Discord, plus anything else through webhooks (Zapier, Make, n8n).

Nothing is posted on a timer: posts wait until you click **Post** (or **Post next**). So the app doesn't need an always-on server and runs fine on **Vercel**. **Everything is configured in the web UI. You never edit code or config files.**

## Deploy to Vercel (free tier works)

1. Import this GitHub repo at [vercel.com/new](https://vercel.com/new). Framework preset: *Other*; leave the build settings empty.
2. In the project, open **Storage** and add:
   - a **Neon Postgres** database. It sets `DATABASE_URL` for you.
   - a **Blob** store. It sets `BLOB_READ_WRITE_TOKEN`, used for your photos and videos. (Optional — without it, text-only posting still works and the app says so.)
3. Under **Settings → Environment Variables**, add `SECRET_KEY`: any long random string (e.g. from `openssl rand -hex 32`). It encrypts your saved logins, so keep it safe and never change it.
4. Redeploy, open your `https://<project>.vercel.app` address and create your account. The first account is the admin.
5. Go to **Accounts** and connect your networks.

Vercel functions are limited to 60 seconds on this setup. Very large videos to Instagram/Threads can take longer for the network to process; if that happens the post shows as failed and you can retry it.

## Or run it yourself

```sh
npm install
npm start            # → http://localhost:3000   (SQLite + files in ./data)
```

To run it on a server with HTTPS, edit the domain in `docker-compose.yml` and run `docker compose up -d`.

Optional environment variables: `PORT`, `HOST`, `DATABASE_URL` (use Postgres instead of SQLite), `BLOB_READ_WRITE_TOKEN`, `SECRET_KEY`, `ALLOW_SIGNUP=1`, `COOKIE_SECURE=1`.

## Connecting networks

| Network | What you do |
|---|---|
| Mastodon | Type your server name and log in. No developer setup needed. |
| Bluesky | Handle + an app password |
| Telegram | Bot token from @BotFather + your channel/group |
| Discord | A channel webhook URL |
| X, LinkedIn, Facebook/Instagram, Threads | One-time: register a free developer app (the app shows step-by-step instructions and the exact callback URL to paste), then click **Connect** and log in. |
| Anything else | Generic webhook → Zapier / Make / n8n |

Instagram needs a Business/Creator account linked to a Facebook Page. Meta and Threads apps work in Development mode for you as the app admin, so personal use needs no app review.

## Features

- **Queue:** add posts whenever inspiration strikes, reorder them, then publish with **Post next** or each item's **Post** button. A "posts waiting" count shows in the sidebar.
- **Composer:** pick several accounts; live previews per network; character counters that use each network's rules; checks before you post (limits, media rules, JPEG for Instagram, Bluesky's 1 MB images…); **Post now** or **Add to queue**.
- **Customize per network:** different text per account, with one-click AI adaptation.
- **Media:** drag & drop, paste or a reusable library; alt text; images and video (carousels on Instagram and Threads, media groups on Telegram). On Vercel, uploads go straight from your browser to Blob storage.
- **AI assistant (Claude):** write from an idea, improve, shorten, add hashtags, change tone, custom instructions. You bring your own Anthropic API key.
- **RSS autopilot:** new blog, YouTube or podcast items are added to your queue (or posted instantly) when you open the app.
- **Analytics:** likes, reposts, replies and views pulled from the networks; per-day and per-network charts; top posts; and a heatmap of *your* best times to click Post.
- **Reliability:** a quick automatic retry for temporary network errors; partial failures retry only the networks that failed. It never double-posts. Accounts are flagged when they need reconnecting, and failure alerts can go to Telegram or Discord.
- **Snippets:** saved hashtag sets and signatures. **UTM link tagging** per network. **CSV import** (up to 500 posts into the queue). **CSV/JSON export.**
- **Security:** credentials and settings are encrypted at rest (AES-256-GCM); scrypt passwords; HttpOnly cookies + CSRF origin check; rate-limited login; strict CSP; uploads are checked by their actual file content.
- Installable as an app (PWA), dark mode, works on phones. Optional extra users (Settings → Users), each fully separated.

## Development

```sh
npm test          # 25 tests on SQLite
npm run test:pg   # the same tests on Postgres (expects one at 127.0.0.1:5433)
npm run vendor    # rebuild public/vendor/blob-upload.js (browser upload helper)
```

Each network's API flow is tested against a fake server, so the tests need no real accounts.
