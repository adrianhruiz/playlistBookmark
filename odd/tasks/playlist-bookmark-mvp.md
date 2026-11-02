# playlist-bookmark-mvp

Objective: implement the Cloudflare Worker described in README.md (cron tracker + Telegram bot + KV).
Branch: `adrianhruiz/inicio` · Delivery: ask-on-risk · Test runner: `npm test` (vitest)

## Specs

- S1. Project scaffold: TypeScript Cloudflare Worker with Wrangler, KV binding, cron `* * * * *`, vitest tests runnable offline.
- S2. Cron tracker (README "Cron tracker"): polls `GET /v1/me/player` and `GET /v1/me/player/recently-played`; "Stores `{ playlist, track, position, updated_at }` per playlist." One record per playlist, overwritten on each poll.
- S3. Spotify connection (README "Once (setup)"): `/start` → "Connect your Spotify" [link] → Spotify login → "✅ Connected. Tracking your playlists."
- S4. Commands (README "Commands"):
  - `/resume`: "Lists your bookmarked playlists. Tapping one saves the current playlist at the exact second, then resumes the chosen one."
  - `/save`: "Saves the current playlist at the exact second (use it before switching in the Spotify app)."
  - `/now`: "Shows what is playing, at which second, and on which device."
- S5. Free vs Premium (README): on `403 PREMIUM_REQUIRED`, `/resume` answers "You were at '<track>', <m:ss>" [Open in Spotify] instead of playing.
- S6. Known limit: "`/resume` fails if Spotify is not open on any device" → "The bot asks you to open Spotify and retry".
- S7. Secrets only via `.dev.vars` / `wrangler secret put`, never in the repository.
- S8 (assumption). Single user: the first private chat that sends `/start` becomes the owner; group chats and other chats are ignored, and only the owner can complete the Spotify login. Telegram webhook requests are authenticated with `X-Telegram-Bot-Api-Secret-Token`, failing closed when the secret is unset.

## Tasks

- [x] T1 · S1, S2, S7 · inline · scaffold + KV bookmark store + Spotify client + cron tracker · commit 1
- [x] T2 · S3, S4, S5, S6, S8 · inline · OAuth routes + Telegram webhook + commands · commit 2
- [x] T3 · S1, S7 · inline · setup/deploy docs in README · commit 3
- [x] T5 · S8 · inline · security hardening from the independent verifier · commit 5
- [ ] T4 · all · blocked (external) · real deploy with the user's Spotify/Telegram/Cloudflare credentials

## Log

- L1 (2026-11-02): "Empieza el proyecto"
- L2: Route: inline for all tasks; no Writer trigger (units depend on each other, single session).
- L3: Evidence: `npm test` 34/34 passing, `tsc --noEmit` clean, `wrangler deploy --dry-run` bundles (19 KiB). Tests were written right after each module, so RED was not observed separately.
- L4: Finding: KV free tier = 1,000 writes/day; tracker writes ~1/min only while playing (skips paused). Documented in README Known limits; D1 is the fallback.
- L5: Next: T4 needs the user's Spotify app, Telegram bot token and Cloudflare login (README "Setup").
- L6 (2026-11-02): "Entonces hace falta dos api keys, no? Puedes construir el resto mientras tanto?" → added `npm run setup:telegram` (commit 0b71aa9).
- L7: Independent verifier (Risk item 2): S1–S8 pass, no blockers, 6 advisories. Fixed 1–5 in T5 (malformed body 500, owner race at /callback, group ownership, empty secret, failed token exchange). RED observed on 5 new tests, then 40/40 green, tsc clean.
