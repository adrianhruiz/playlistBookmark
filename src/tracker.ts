import type { Playback, SpotifyClient } from "./spotify";
import type { Bookmark, BookmarkStore } from "./store";

type Spotify = Pick<SpotifyClient, "getPlayback" | "getRecentlyPlayed" | "getPlaylistName">;

async function playlistName(spotify: Spotify, existing: Bookmark | null, playlistId: string) {
  if (existing) return existing.playlistName;
  try {
    return await spotify.getPlaylistName(playlistId);
  } catch {
    // Some playlists (e.g. Spotify-owned ones) are not readable by third-party apps.
    return "Unknown playlist";
  }
}

/**
 * Saves the current playlist at its exact position.
 * Returns the bookmark, or null when no playlist is playing.
 */
export async function saveCurrent(
  spotify: Spotify,
  store: BookmarkStore,
  now: number,
  playback?: Playback | null,
): Promise<Bookmark | null> {
  const current = playback === undefined ? await spotify.getPlayback() : playback;
  if (!current?.playlistId) return null;

  const existing = await store.get(current.playlistId);
  // Paused on the same spot: skip the write (KV free tier allows 1,000 writes per day).
  if (existing && existing.trackUri === current.trackUri && existing.positionMs === current.progressMs) {
    return existing;
  }

  const bookmark: Bookmark = {
    playlistId: current.playlistId,
    playlistName: await playlistName(spotify, existing, current.playlistId),
    trackUri: current.trackUri,
    trackName: current.trackName,
    artistName: current.artistName,
    positionMs: current.progressMs,
    updatedAt: now,
  };
  await store.save(bookmark);
  return bookmark;
}

/**
 * Recovers playlists played between two polls from the recently-played history.
 * Only track-level precision: the bookmark points at the start of the last track heard.
 */
async function recoverMissedPlaylists(
  spotify: Spotify,
  store: BookmarkStore,
  currentPlaylistId: string | null,
): Promise<void> {
  const items = await spotify.getRecentlyPlayed();
  const latestByPlaylist = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    if (!item.playlistId || item.playlistId === currentPlaylistId) continue;
    const latest = latestByPlaylist.get(item.playlistId);
    if (!latest || item.playedAt > latest.playedAt) latestByPlaylist.set(item.playlistId, item);
  }

  for (const [playlistId, item] of latestByPlaylist) {
    const existing = await store.get(playlistId);
    if (existing && (existing.updatedAt >= item.playedAt || existing.trackUri === item.trackUri)) continue;
    await store.save({
      playlistId,
      playlistName: await playlistName(spotify, existing, playlistId),
      trackUri: item.trackUri,
      trackName: item.trackName,
      artistName: item.artistName,
      positionMs: 0,
      updatedAt: item.playedAt,
    });
  }
}

/** One cron tick: follow the account's playback and keep one bookmark per playlist. */
export async function track(spotify: Spotify, store: BookmarkStore, now: number): Promise<void> {
  const playback = await spotify.getPlayback();
  await recoverMissedPlaylists(spotify, store, playback?.playlistId ?? null);
  await saveCurrent(spotify, store, now, playback);
}
