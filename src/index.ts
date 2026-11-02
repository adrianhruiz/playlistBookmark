import { handleUpdate } from "./bot";
import type { Env } from "./env";
import { SpotifyClient } from "./spotify";
import { BookmarkStore, OAuthStateStore, OwnerStore } from "./store";
import { TelegramClient, type TelegramUpdate } from "./telegram";
import { track } from "./tracker";

function spotifyFor(env: Env) {
  return new SpotifyClient({ clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET, kv: env.KV });
}

function html(body: string, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>playlistBookmark</title><p>${body}</p>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function telegramWebhook(request: Request, env: Env): Promise<Response> {
  // Fail closed: an unset secret must not turn authentication off.
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const update = (await request.json()) as TelegramUpdate;
    await handleUpdate(update, {
      spotify: spotifyFor(env),
      telegram: new TelegramClient(env.TELEGRAM_BOT_TOKEN),
      bookmarks: new BookmarkStore(env.KV),
      owner: new OwnerStore(env.KV),
      oauthStates: new OAuthStateStore(env.KV),
      spotifyClientId: env.SPOTIFY_CLIENT_ID,
      baseUrl: env.BASE_URL,
      now: Date.now(),
    });
  } catch (error) {
    // Answer 200 anyway: Telegram would otherwise retry the same update forever.
    console.error("Failed to handle Telegram update", error);
  }
  return new Response("OK");
}

async function spotifyCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return html("Spotify login was cancelled.", 400);

  const chatId = await new OAuthStateStore(env.KV).consume(state);
  if (chatId === null) return html("This login link expired. Send /start to the bot again.", 400);

  // A second chat may have raced the first /start; only the owner can link the Spotify account.
  if (!(await new OwnerStore(env.KV).isOwner(chatId))) return html("This chat does not own the bot.", 403);

  try {
    await spotifyFor(env).connect(code, `${env.BASE_URL}/callback`);
  } catch (error) {
    console.error("Spotify token exchange failed", error);
    return html("Spotify login failed. Send /start to the bot again.", 502);
  }
  try {
    await new TelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, "✅ Connected. Tracking your playlists.");
  } catch (error) {
    // Spotify is connected anyway; the confirmation message is a courtesy.
    console.error("Failed to confirm the connection on Telegram", error);
  }
  return html("✅ Connected. You can close this tab and go back to Telegram.");
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") return telegramWebhook(request, env);
    if (request.method === "GET" && url.pathname === "/callback") return spotifyCallback(url, env);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env): Promise<void> {
    const spotify = spotifyFor(env);
    if (!(await spotify.isConnected())) return;
    await track(spotify, new BookmarkStore(env.KV), Date.now());
  },
} satisfies ExportedHandler<Env>;
