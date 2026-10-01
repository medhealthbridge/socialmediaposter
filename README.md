# Social Poster

A self-hosted, single-user, Hootsuite-style scheduler for personal use. No npm dependencies — just Node ≥ 22.13 (uses built-in `node:sqlite` and `fetch`).

## Run

```sh
npm start                      # http://127.0.0.1:3000
APP_PASSWORD=secret HOST=0.0.0.0 PORT=3000 npm start   # exposed: ALWAYS set a password (HTTP Basic, any username)
npm test
```

Data lives in `data/poster.db` (override with `DB_PATH`). Credentials are stored there in plain text — keep it private and back it up.

## Hootsuite features mirrored

| Hootsuite | Here |
|---|---|
| Composer, multi-network publish | Compose tab: pick several accounts, live per-network character counters, preview |
| Scheduling + calendar | Schedule at any time; month calendar, click to edit |
| Drafts | “Save as draft” |
| Post now / retry | Queue tab; retry re-sends only failed networks |
| Bulk Composer (CSV, 350 posts) | Bulk upload tab: `text,scheduled_at,accounts`, per-row error report |
| Best time to post | Generic suggested windows per network (static heuristics, edit `BEST` in `public/app.js`) |
| Analytics | Publishing activity per account/day and status counts |
| Social inbox, team approvals, paid ads | Not included (single-user) |

## Networks

Built-in: **Mastodon**, **Bluesky**, **Telegram**, **Discord webhook**, **generic webhook**, and **Mock** (dry run). Add one in `src/providers/index.js` (`publish({config,text,media}) → {id,url}`).

Instagram, Facebook, LinkedIn, X, TikTok and YouTube need an approved developer app / OAuth (X's posting API is paid), so they are not built in. For those, point the **generic webhook** at Zapier/Make/n8n, or add a provider once you have API credentials.

## How it works

`setInterval` (15s) → `service.runDue()` atomically claims due posts (`scheduled → publishing`) → per-account delivery rows are published and tracked, so partial failures and restarts never double-post. The scheduler only runs while the server is up; use a small VPS or always-on machine.
