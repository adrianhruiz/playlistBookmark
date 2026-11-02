# playlistBookmark

A Telegram bot that remembers where you left off in each Spotify playlist and lets you resume it from that exact song and second — on any device, with no PC or server of your own running.

> **Status:** MVP implemented (tracker, `/start`, `/resume`, `/save`, `/now`). Not deployed yet.

## The problem

Spotify resumes podcasts and audiobooks where you left them, but not music playlists. Switch from playlist A to playlist B, and when you come back to A you start over.

## How it works

One Cloudflare Worker (free tier) does everything:

```
Cloudflare Worker
 ├─ cron, every 1 min → reads what you are playing → updates the bookmark of that playlist
 ├─ Telegram webhook  → answers /resume, /save, /now
 └─ KV storage        → Spotify refresh token + one bookmark per playlist
```

| Piece | Role |
|-------|------|
| Cron tracker | Polls `GET /v1/me/player` and `GET /v1/me/player/recently-played`. Stores `{ playlist, track, position, updated_at }` per playlist. |
| Telegram bot | Runs only when you send a message (webhook), so nothing stays on. |
| Storage | One record per playlist, overwritten on each poll. |

Nothing runs on your PC and you rent no VPS. The Worker wakes up once a minute and whenever you message the bot.

## A normal day

**Once (setup)**

```
You → /start
Bot → "Connect your Spotify" [link]
You → log in to Spotify → Accept
Bot → "✅ Connected. Tracking your playlists."
```

**Every day**

```
08:00  You play "Gym Mix" on your phone for 40 min.
       └─ every minute the cron saves: Gym Mix → track 12, 2:15

08:40  You switch to "Focus" in the Spotify app.
       └─ Gym Mix stays frozen at track 12, 2:15 (±1 min)

13:00  You keep listening to Focus on your PC.
       └─ same bookmark: the cron follows your account, not the device

18:00  You want Gym Mix back:
       You → /resume
       Bot → 🎵 Focus    · track 30, 1:02 · 1 min ago
             🏋️ Gym Mix  · track 12, 2:15 · 9 h ago
       You → tap "Gym Mix"
       └─ the bot saves Focus at the exact second
       └─ Gym Mix starts playing at track 12, 2:15
```

**Commands**

| Command | What it does |
|---------|--------------|
| `/resume` | Lists your bookmarked playlists. Tapping one saves the current playlist at the exact second, then resumes the chosen one. |
| `/save` | Saves the current playlist at the exact second (use it before switching in the Spotify app). |
| `/now` | Shows what is playing, at which second, and on which device. |

In short: listen as usual, and open the bot only to resume.

## Free vs Premium

Spotify splits its API into two kinds of permission:

- **Read** (what is playing, at which second, your history): any account.
- **Control** (play, pause, skip, seek): **Premium only**. A free account gets `403 PREMIUM_REQUIRED`.

So the bot behaves differently depending on your account:

| | Free | Premium |
|---|---|---|
| Tracking and bookmarks | ✅ | ✅ |
| `/now`, `/save` | ✅ | ✅ |
| `/resume` | Tells you where you were; you open Spotify and seek yourself | Starts playback at the exact song and second |

```
Free     → Bot: "You were at 'Thunderstruck' (#12), 2:15" [Open in Spotify]
Premium  → Bot tells Spotify to play Gym Mix, track 12, at 2:15 ▶️
```

Without Premium the bot is a notebook. With Premium it is a remote control.

## Known limits

| Limit | Why | Mitigation |
|-------|-----|------------|
| Up to ~1 min of position lost when you switch playlists in the Spotify app | The cron polls once a minute | Switch with `/resume`, or send `/save` first |
| A playlist played for less than 1 min may be missed by the poll | It started and stopped between two polls | `recently-played` recovers it at track level |
| Shuffle: the right song resumes, but the following order differs | The API does not expose the full queue | None |
| The bot answers only the first private chat that sent `/start` | It is a personal bot: that chat owns it | Delete the `owner:chat_id` KV key to reset |
| `/resume` fails if Spotify is not open on any device | Spotify needs an active device to play | The bot asks you to open Spotify and retry |
| Paused or idle time does not count as a write, but listening does: about 1 KV write per minute | KV free tier allows 1,000 writes per day (~16 h of listening) | Writes are skipped while paused; move to D1 if it ever falls short |
| Only one playlist plays at a time | A Spotify account has one active player | Not a real limit: the bookmarks cover alternating |

## Requirements

- A Cloudflare account (free tier: Workers, cron triggers, KV).
- A Spotify app from the [Developer Dashboard](https://developer.spotify.com/dashboard) (Client ID, Client Secret, redirect URI `https://playlistbookmark.<subdomain>.workers.dev/callback`).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- Spotify Premium for one-tap resume (optional, see above).

Secrets go in `.dev.vars` locally (git-ignored) and in `wrangler secret put` for production — never in the repository.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in the values
npm test                         # offline unit tests
```

**1. Spotify** — create an app in the [Developer Dashboard](https://developer.spotify.com/dashboard) and add the redirect URI `<BASE_URL>/callback`.

**2. Telegram** — create a bot with [@BotFather](https://t.me/BotFather) and copy its token.

**3. Cloudflare**

```bash
npx wrangler login
npx wrangler kv namespace create KV         # paste the id into wrangler.jsonc
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string
npx wrangler secret put BASE_URL                  # https://playlistbookmark.<subdomain>.workers.dev
npm run deploy
```

**4. Point Telegram at the Worker** (once): registers the webhook with its secret and publishes the command menu. Reads `.dev.vars` or the environment.

```bash
npm run setup:telegram
```

**5.** Send `/start` to your bot and connect Spotify.

### Routes

| Route | Purpose |
|-------|---------|
| `POST /telegram` | Telegram webhook; rejects calls without the `X-Telegram-Bot-Api-Secret-Token` header |
| `GET /callback` | Spotify OAuth redirect; stores the refresh token in KV |
| cron `* * * * *` | Tracker tick; does nothing until Spotify is connected |

### Code map

| File | Role |
|------|------|
| `src/index.ts` | Worker entry: routes and cron |
| `src/tracker.ts` | Cron logic: one bookmark per playlist, recovery from recently-played |
| `src/bot.ts` | Telegram commands |
| `src/spotify.ts` | Spotify Web API and OAuth tokens |
| `src/telegram.ts` | Telegram Bot API |
| `src/store.ts` | KV records: bookmarks, owner, OAuth state |

## Tech stack

TypeScript · Cloudflare Workers · Wrangler · KV · Spotify Web API · Telegram Bot API
