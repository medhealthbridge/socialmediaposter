# Social Poster

Your own social media poster, like Hootsuite but simpler: write posts once, keep them in a **queue**, and publish with one click to X, Instagram, Facebook Pages, TikTok, YouTube, LinkedIn, Pinterest, Threads, Bluesky, Mastodon, Telegram and Discord, plus anything else through webhooks (Zapier, Make, n8n).

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
| X, LinkedIn, Facebook/Instagram, TikTok, YouTube, Pinterest, Threads | One-time: register a free developer app (the app shows step-by-step instructions and the exact callback URL to paste), then click **Connect** and log in. |
| Anything else | Generic webhook → Zapier / Make / n8n |

Notes per network:

- **Instagram** needs a Business/Creator account linked to a Facebook Page. Meta and Threads apps work in Development mode for you as the app admin, so personal use needs no app review.
- **TikTok** makes every post private (“Only me”) until TikTok audits your app — their rule, not a bug. You choose who can see posts in **Accounts → ⋯ → Post settings**; TikTok requires that choice to be yours, with no default. Videos upload directly; photo posts need the public HTTPS address.
- **YouTube** uploads stay Private until Google audits your Cloud project — again their rule. The first line of your post becomes the video title (100 characters max), the rest the description. One video per post.
- **Pinterest** adds one account per board, so you choose the board by choosing the account. A pin needs one image; the first line becomes the title and the first link in the text becomes the pin's link.

## Features

- **Queue:** add posts whenever inspiration strikes, reorder them, then publish with **Post next** or each item's **Post** button. A "posts waiting" count shows in the sidebar.
- **Scheduling:** pick a date and time, or "next free time" from your weekly posting slots, and posts go out on their own. Evergreen posts repost themselves every N days. See *Automatic publishing* below.
- **Composer:** pick several accounts; live previews per network; character counters that use each network's rules; checks before you post (limits, media rules, JPEG for Instagram, Bluesky's 1 MB images…); **Post now** or **Add to queue**.
- **Customize per network:** different text per account, with one-click AI adaptation.
- **Media:** drag & drop, paste or a reusable library; alt text; images and video (carousels on Instagram and Threads, media groups on Telegram). On Vercel, uploads go straight from your browser to Blob storage.
- **AI assistant:** write from an idea, improve, shorten, add hashtags, change tone, custom instructions. Pick your provider in Settings — **Google Gemini** (free tier, no card; key from [AI Studio](https://aistudio.google.com/apikey)) or **Anthropic Claude** (paid). Gemini's model list is fetched from Google, so it stays current; the Flash models are the free ones.
- **RSS autopilot:** new blog, YouTube or podcast items are added to your queue (or posted instantly) when you open the app.
- **Analytics:** likes, reposts, replies and views pulled from the networks; per-day and per-network charts; top posts; and a heatmap of *your* best times to click Post.
- **Reliability:** a quick automatic retry for temporary network errors; partial failures retry only the networks that failed. It never double-posts. Accounts are flagged when they need reconnecting, and failure alerts can go to Telegram or Discord.
- **Snippets:** saved hashtag sets and signatures. **UTM link tagging** per network. **CSV import** (up to 500 posts into the queue). **CSV/JSON export.**
- **Security:** credentials and settings are encrypted at rest (AES-256-GCM); scrypt passwords; HttpOnly cookies + CSRF origin check; rate-limited login; strict CSP; uploads are checked by their actual file content.
- Installable as an app (PWA), dark mode, works on phones. Optional extra users (Settings → Users), each fully separated.

## Automatic publishing

The app has no clock of its own (that is what lets it run on Vercel's free plan), so a timer calls it:

- **Easiest:** open **Settings → Scheduling**, copy your private timer address, and paste it into a free account at [cron-job.org](https://cron-job.org) set to every 15 minutes. The page then shows "Working — last automatic run 2 minutes ago".
- **On Vercel:** add an environment variable `CRON_SECRET` (any long random text) and redeploy. `vercel.json` already asks Vercel to call `/api/cron` hourly; Vercel sends that secret for you. The free plan allows one cron run per day, so use the option above as well if you want finer timing.

Without a timer nothing is lost — scheduled posts simply wait in the app until you publish them.

## The built-in agent

Open **Agent** in the sidebar and type what you want: *"write three posts about the weekend sale and queue them"*, *"what's in my queue?"*, *"did anything fail recently, and why?"*. It uses the app's own tools and shows you which ones it used.

It runs on the same API key as the AI assistant (Gemini's free tier is fine). **Publishing is switched off until you allow it** — the toggle is at the top of the Agent page. With it off the agent can write, queue, schedule, edit and read results, but cannot send anything out.

## Activity log

**Activity** in the sidebar records everything: posts published or failed (with the error), accounts connected, settings changed, timer runs, RSS items and every tool the agent or a connected assistant used. Each entry says who did it — you, the agent, the assistant, the timer or RSS — so nothing that happens while you are away is a mystery. Filter by kind, or switch on *Only problems*.

## Let an assistant post for you (MCP)

Social Poster speaks **MCP**, so Claude can use it: *“draft three posts about the new menu and queue them”*, *“what did best last month?”*, *“publish the next one”*.

1. In the app go to **Settings → Assistant access**, create a key and copy it.
2. In Claude: **Settings → Connectors → Add custom connector**, and paste the connector URL shown on that page (`https://your-app/mcp`). If it asks for a key, paste the key; if it only accepts a URL, use the full URL with `?key=…` that the app shows you.

The assistant gets these tools: `list_accounts`, `add_to_queue`, `publish_post`, `list_posts`, `update_post`, `delete_post`, `check_post`, `get_activity_log` and `get_analytics`. New posts go to the **queue** by default — nothing is published unless you ask for it. Remove a key any time to cut access off.

## Development

```sh
npm test          # 48 tests on SQLite
npm run test:pg   # the same tests on Postgres (expects one at 127.0.0.1:5433)
npm run vendor    # rebuild public/vendor/blob-upload.js (browser upload helper)
```

Each network's API flow is tested against a fake server, so the tests need no real accounts.
