# Social Poster

A self-hosted, single-user, Hootsuite-style scheduler for personal use. No npm dependencies — just Node ≥ 22.13 (uses built-in `node:sqlite` and `fetch`).

## Run

```sh
npm start                      # http://127.0.0.1:3000
HOST=0.0.0.0 PORT=3000 COOKIE_SECURE=1 npm start      # behind HTTPS (reverse proxy) when shared
npm test
```

The first person to open the app creates the **admin** account. The admin adds more users in the **Team** tab (or set `ALLOW_SIGNUP=1` for open signup). Each user only sees their own accounts, posts and queue.

| Env | Purpose |
|---|---|
| `DB_PATH` | SQLite file (default `data/poster.db`) |
| `SECRET_KEY` | Key for encrypting network credentials (AES-256-GCM). If unset, a random key is created in `data/secret.key`. **Back it up with the DB — without it, saved credentials are unreadable.** |
| `ALLOW_SIGNUP=1` | Let anyone register |
| `COOKIE_SECURE=1` | Mark session cookie `Secure` (use behind HTTPS) |

Security: scrypt password hashes, HttpOnly + SameSite=Strict session cookies, JSON-only API bodies, login rate limiting, CSP.

## Hootsuite features mirrored

| Hootsuite | Here |
|---|---|
| Composer, multi-network publish | Compose tab: pick several accounts, live per-network character counters, preview |
| Scheduling + calendar | Schedule at any time; month calendar, click to edit |
| Drafts | “Save as draft” |
| Post now / retry | Queue tab; retry re-sends only failed networks. Transient errors (429/5xx/network) auto-retry with backoff (2, 4 min) |
| Auto-schedule / queue | Weekly queue slots in your timezone; “Add to queue” takes the next free slot |
| Duplicate / reuse | Duplicate any post as a draft |
| Teams / seats | Multi-user with per-user data isolation (no roles beyond admin/user) |
| Bulk Composer (CSV, 350 posts) | Bulk upload tab: `text,scheduled_at,accounts`, per-row error report |
| Best time to post | Generic suggested windows per network (static heuristics, edit `BEST` in `public/app.js`) |
| Analytics | Publishing activity per account/day and status counts |
| Social inbox, team approvals, paid ads | Not included (single-user) |

## Networks

Built-in: **Mastodon**, **Bluesky**, **Telegram**, **Discord webhook**, **generic webhook**, and **Mock** (dry run). Add one in `src/providers/index.js` (`publish({config,text,media}) → {id,url}`).

Instagram, Facebook, LinkedIn, X, TikTok and YouTube need an approved developer app / OAuth (X's posting API is paid), so they are not built in. For those, point the **generic webhook** at Zapier/Make/n8n, or add a provider once you have API credentials.

## How it works

`setInterval` (15s) → `service.runDue()` atomically claims due posts (`scheduled → publishing`) → per-account delivery rows are published and tracked, so partial failures and restarts never double-post. The scheduler only runs while the server is up; use a small VPS or always-on machine.

## If you want to sell it

Not legal advice — check with a lawyer. Features aren't owned, but don't use Hootsuite's name, logo, design or copy; this code is original. The real hurdles are: each network's developer terms and app review (subscribers would connect through *your* registered app), privacy law (you'd store other people's tokens: privacy policy, terms, GDPR if EU/UK), payments and tax. Missing for a paid product: billing/plans, email verification & password reset, media uploads, OAuth connect flows, Postgres + backups, and a hosted deployment.
