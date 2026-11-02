import { formatAgo, formatPosition } from "./format";
import { authorizeUrl, SpotifyNotConnectedError, type SpotifyClient } from "./spotify";
import type { BookmarkStore, OAuthStateStore, OwnerStore } from "./store";
import type { InlineButton, TelegramClient, TelegramUpdate } from "./telegram";
import { saveCurrent } from "./tracker";

export interface BotDeps {
  spotify: Pick<SpotifyClient, "getPlayback" | "getRecentlyPlayed" | "getPlaylistName" | "play">;
  telegram: Pick<TelegramClient, "sendMessage" | "answerCallbackQuery">;
  bookmarks: BookmarkStore;
  owner: OwnerStore;
  oauthStates: OAuthStateStore;
  spotifyClientId: string;
  baseUrl: string;
  now: number;
}

const RESUME_PREFIX = "resume:";
const UNTRACK_PREFIX = "untrack:";
const TRACK_PREFIX = "track:";

const HELP = [
  "/resume — pick a playlist to resume where you left off",
  "/save — save the current playlist at the exact second",
  "/now — what is playing, at which second, on which device",
  "/untrack — stop following a playlist",
  "/track — follow an ignored playlist again",
].join("\n");

const NOT_CONNECTED = "Spotify is not connected. Send /start to connect it.";

export async function handleUpdate(update: TelegramUpdate, deps: BotDeps): Promise<void> {
  if (update.callback_query) {
    const { id, data, message } = update.callback_query;
    await deps.telegram.answerCallbackQuery(id);
    const chatId = message?.chat.id;
    if (chatId === undefined || !(await deps.owner.isOwner(chatId))) return;
    if (data?.startsWith(RESUME_PREFIX)) {
      await withSpotify(deps, chatId, () => resume(deps, chatId, data.slice(RESUME_PREFIX.length)));
    } else if (data?.startsWith(UNTRACK_PREFIX)) {
      await untrack(deps, chatId, data.slice(UNTRACK_PREFIX.length));
    } else if (data?.startsWith(TRACK_PREFIX)) {
      await retrack(deps, chatId, data.slice(TRACK_PREFIX.length));
    }
    return;
  }

  const message = update.message;
  if (!message?.text) return;
  const chatId = message.chat.id;
  const command = message.text.trim().split(/[\s@]/)[0];

  if (command === "/start") {
    // Only a private chat may own the bot: in a group every member could control the playback.
    if (message.chat.type === "private" && (await deps.owner.claim(chatId))) await start(deps, chatId);
    return;
  }
  if (!(await deps.owner.isOwner(chatId))) return;

  switch (command) {
    case "/resume":
      return withSpotify(deps, chatId, () => listBookmarks(deps, chatId));
    case "/save":
      return withSpotify(deps, chatId, () => save(deps, chatId));
    case "/now":
      return withSpotify(deps, chatId, () => now(deps, chatId));
    case "/untrack":
      return listUntrackable(deps, chatId);
    case "/track":
      return listIgnored(deps, chatId);
    default:
      return deps.telegram.sendMessage(chatId, HELP);
  }
}

async function withSpotify(deps: BotDeps, chatId: number, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof SpotifyNotConnectedError) return deps.telegram.sendMessage(chatId, NOT_CONNECTED);
    throw error;
  }
}

async function start(deps: BotDeps, chatId: number): Promise<void> {
  const state = await deps.oauthStates.create(chatId);
  const url = authorizeUrl(deps.spotifyClientId, `${deps.baseUrl}/callback`, state);
  await deps.telegram.sendMessage(chatId, "Connect your Spotify", [[{ text: "Connect Spotify", url }]]);
}

async function listBookmarks(deps: BotDeps, chatId: number): Promise<void> {
  // Freshen the current playlist so the list shows its exact second.
  await saveCurrent(deps.spotify, deps.bookmarks, deps.now);
  const bookmarks = await deps.bookmarks.list();
  if (bookmarks.length === 0) {
    return deps.telegram.sendMessage(chatId, "No bookmarks yet. Play a playlist and I will start tracking it.");
  }
  const buttons: InlineButton[][] = bookmarks.map((bookmark) => [
    {
      text: `${bookmark.playlistName} · ${bookmark.trackName}, ${formatPosition(bookmark.positionMs)} · ${formatAgo(deps.now - bookmark.updatedAt)}`,
      callback_data: RESUME_PREFIX + bookmark.playlistId,
    },
  ]);
  await deps.telegram.sendMessage(chatId, "Which playlist do you want to resume?", buttons);
}

async function resume(deps: BotDeps, chatId: number, playlistId: string): Promise<void> {
  const bookmark = await deps.bookmarks.get(playlistId);
  if (!bookmark) return deps.telegram.sendMessage(chatId, "I have no bookmark for that playlist anymore.");

  await saveCurrent(deps.spotify, deps.bookmarks, deps.now);
  const where = `'${bookmark.trackName}', ${formatPosition(bookmark.positionMs)}`;
  const result = await deps.spotify.play(bookmark.playlistId, bookmark.trackUri, bookmark.positionMs);

  switch (result) {
    case "ok":
      return deps.telegram.sendMessage(chatId, `▶️ Resuming ${bookmark.playlistName} at ${where}`);
    case "premium_required":
      return deps.telegram.sendMessage(chatId, `You were at ${where} in ${bookmark.playlistName}`, [
        [{ text: "Open in Spotify", url: `https://open.spotify.com/playlist/${bookmark.playlistId}` }],
      ]);
    case "no_active_device":
      return deps.telegram.sendMessage(
        chatId,
        `Spotify is not open on any device. Open it, then tap ${bookmark.playlistName} again.`,
      );
  }
}

async function save(deps: BotDeps, chatId: number): Promise<void> {
  const playback = await deps.spotify.getPlayback();
  const ignored = playback?.playlistId ? await deps.bookmarks.getIgnored(playback.playlistId) : null;
  if (ignored) {
    return deps.telegram.sendMessage(
      chatId,
      `You stopped following ${ignored.playlistName}. Send /track to follow it again.`,
    );
  }
  const bookmark = await saveCurrent(deps.spotify, deps.bookmarks, deps.now, playback);
  if (!bookmark) return deps.telegram.sendMessage(chatId, "Nothing to save: no playlist is playing.");
  await deps.telegram.sendMessage(
    chatId,
    `💾 Saved ${bookmark.playlistName} at '${bookmark.trackName}', ${formatPosition(bookmark.positionMs)}`,
  );
}

async function now(deps: BotDeps, chatId: number): Promise<void> {
  const playback = await deps.spotify.getPlayback();
  if (!playback) return deps.telegram.sendMessage(chatId, "Nothing is playing.");
  const playlistName = playback.playlistId
    ? ((await deps.bookmarks.get(playback.playlistId))?.playlistName ?? (await deps.spotify.getPlaylistName(playback.playlistId)))
    : null;
  const lines = [
    `${playback.isPlaying ? "▶️" : "⏸️"} ${playback.trackName} — ${playback.artistName}`,
    `${formatPosition(playback.progressMs)} · ${playback.deviceName ?? "unknown device"}`,
    playlistName ? `Playlist: ${playlistName}` : "Not playing from a playlist",
  ];
  await deps.telegram.sendMessage(chatId, lines.join("\n"));
}

async function listUntrackable(deps: BotDeps, chatId: number): Promise<void> {
  const bookmarks = await deps.bookmarks.list();
  if (bookmarks.length === 0) return deps.telegram.sendMessage(chatId, "No bookmarks to stop following.");
  const buttons: InlineButton[][] = bookmarks.map((bookmark) => [
    { text: bookmark.playlistName, callback_data: UNTRACK_PREFIX + bookmark.playlistId },
  ]);
  await deps.telegram.sendMessage(chatId, "Which playlist do you want to stop following?", buttons);
}

async function untrack(deps: BotDeps, chatId: number, playlistId: string): Promise<void> {
  const bookmark = await deps.bookmarks.get(playlistId);
  if (!bookmark) return deps.telegram.sendMessage(chatId, "I have no bookmark for that playlist anymore.");
  await deps.bookmarks.ignore(playlistId, bookmark.playlistName);
  await deps.telegram.sendMessage(
    chatId,
    `🚫 Stopped following ${bookmark.playlistName}. Send /track to follow it again.`,
  );
}

async function listIgnored(deps: BotDeps, chatId: number): Promise<void> {
  const ignored = await deps.bookmarks.listIgnored();
  if (ignored.length === 0) return deps.telegram.sendMessage(chatId, "You are following every playlist.");
  const buttons: InlineButton[][] = ignored.map((playlist) => [
    { text: playlist.playlistName, callback_data: TRACK_PREFIX + playlist.playlistId },
  ]);
  await deps.telegram.sendMessage(chatId, "Which playlist do you want to follow again?", buttons);
}

async function retrack(deps: BotDeps, chatId: number, playlistId: string): Promise<void> {
  const playlist = await deps.bookmarks.unignore(playlistId);
  if (!playlist) return deps.telegram.sendMessage(chatId, "That playlist is already being followed.");
  await deps.telegram.sendMessage(
    chatId,
    `✅ Following ${playlist.playlistName} again. Play it and I will bookmark it.`,
  );
}
