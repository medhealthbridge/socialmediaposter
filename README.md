# Social Poster

A self-hosted social media scheduler, like Hootsuite but yours. Write once, publish to X, Instagram, Facebook Pages, LinkedIn, Threads, Bluesky, Mastodon, Telegram and Discord, plus anything else through webhooks (Zapier, Make, n8n). **Everything is configured in the web UI. You never edit code or config files.**

## Start it

```sh
npm install
npm start            # → http://localhost:3000
```

Open the page and create your account; the first account is the admin. Then go to **Accounts** and connect your networks.

To run it on a server with HTTPS (needed for Instagram, Facebook and Threads), edit the domain in `docker-compose.yml` and run `docker compose up -d`. Then set **Settings → General → Public URL** to `https://your-domain`.

Optional environment variables: `PORT`, `HOST` (default `127.0.0.1`), `DB_PATH`, `MEDIA_DIR`, `SECRET_KEY`, `ALLOW_SIGNUP=1`, `COOKIE_SECURE=1`.

## Connecting networks

| Network | What you do |
|---|---|
| Mastodon | Type your server name and log in. No developer setup needed. |
| Bluesky | Handle + an app password |
| Telegram | Bot token from @BotFather + your channel/group |
| Discord | A channel webhook URL |
| X, LinkedIn, Facebook/Instagram, Threads | One-time: register a free developer app (the app shows step-by-step instructions and the exact callback URL to paste), then click **Connect** and log in. |
| Anything else | Generic webhook → Zapier / Make / n8n |

Instagram needs a Business/Creator account linked to a Facebook Page. Instagram and Threads download your media from your server, so they need the HTTPS public URL. Meta and Threads apps work in Development mode for you as the app admin, so personal use needs no app review.

## Features

- **Composer:** pick several accounts; live previews per network; character counters that use each network's rules; checks before you post (limits, media rules, JPEG for Instagram, Bluesky's 1 MB images…).
- **Customize per network:** different text per account, with one-click AI adaptation.
- **Media:** drag & drop, paste or a reusable library; alt text; images and video (carousels on Instagram and Threads, media groups on Telegram).
- **Scheduling:** post now, pick a date, **queue** into your weekly posting times, or save as a draft. Times use your timezone, DST-safe.
- **Calendar:** month and week views; drag to reschedule.
- **AI assistant (Claude):** write from an idea, improve, shorten, add hashtags, change tone, custom instructions. You bring your own Anthropic API key.
- **Evergreen recycling:** automatically repost every N days, a set number of times or forever.
- **RSS autopilot:** new blog, YouTube or podcast items become drafts, queued posts or instant posts, from your own template.
- **Analytics:** likes, reposts, replies and views pulled from the networks; per-day and per-network charts; top posts; a best-time heatmap built from *your* engagement, which the composer suggests from.
- **Reliability:** each network retries temporary errors (2 and 4 minutes later), and partial failures retry only the networks that failed. It never double-posts, even after a crash. Accounts are flagged when they need reconnecting. Failure alerts go to Telegram or Discord, and a pause switch holds everything.
- **Snippets:** saved hashtag sets and signatures. **UTM link tagging** per network. **Bulk CSV import** (up to 500). **CSV/JSON export.**
- **Security:** credentials and settings are encrypted at rest (AES-256-GCM); scrypt passwords; HttpOnly cookies + CSRF origin check; rate-limited login; strict CSP; uploads are checked by their actual file content.
- Installable as an app (PWA), dark mode, works on phones.
- Optional extra users (Settings → Users), each fully separated. Subscriptions and billing are deliberately left out for now.

## Backups

Everything is in `data/`: `poster.db`, `secret.key` (needed to decrypt saved logins) and `media/`. Back up the whole folder.

## Development

`npm test` runs 25 tests. Each network's API flow is exercised against a fake server, so the tests need no real accounts.
