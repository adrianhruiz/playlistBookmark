import { describe, expect, it } from "vitest";
import type { Playback, RecentlyPlayedItem } from "../src/spotify";
import { BookmarkStore } from "../src/store";
import { saveCurrent, track } from "../src/tracker";
import { MemoryKv } from "./fakes";

const HOUR = 3_600_000;

function playback(overrides: Partial<Playback> = {}): Playback {
  return {
    isPlaying: true,
    progressMs: 135000,
    trackUri: "spotify:track:t12",
    trackName: "Thunderstruck",
    artistName: "AC/DC",
    playlistId: "gym",
    deviceName: "Pixel",
    ...overrides,
  };
}

function fakeSpotify(current: Playback | null, recent: RecentlyPlayedItem[] = []) {
  return {
    getPlayback: async () => current,
    getRecentlyPlayed: async () => recent,
    getPlaylistName: async (id: string) => `Name of ${id}`,
  };
}

describe("track", () => {
  it("stores one bookmark per playlist with track and position", async () => {
    const store = new BookmarkStore(new MemoryKv());

    await track(fakeSpotify(playback()), store, 1000);

    expect(await store.get("gym")).toEqual({
      playlistId: "gym",
      playlistName: "Name of gym",
      trackUri: "spotify:track:t12",
      trackName: "Thunderstruck",
      artistName: "AC/DC",
      positionMs: 135000,
      updatedAt: 1000,
    });
  });

  it("overwrites the bookmark of the same playlist on each poll", async () => {
    const kv = new MemoryKv();
    const store = new BookmarkStore(kv);

    await track(fakeSpotify(playback()), store, 1000);
    await track(fakeSpotify(playback({ progressMs: 195000 })), store, 61000);

    expect((await store.list()).length).toBe(1);
    expect((await store.get("gym"))?.positionMs).toBe(195000);
  });

  it("keeps the previous playlist frozen when another one plays", async () => {
    const store = new BookmarkStore(new MemoryKv());

    await track(fakeSpotify(playback()), store, 1000);
    await track(fakeSpotify(playback({ playlistId: "focus", trackUri: "spotify:track:f30", progressMs: 62000 })), store, 61000);

    expect((await store.get("gym"))?.positionMs).toBe(135000);
    expect((await store.get("focus"))?.positionMs).toBe(62000);
    expect((await store.list()).map((b) => b.playlistId)).toEqual(["focus", "gym"]);
  });

  it("ignores playback outside a playlist", async () => {
    const store = new BookmarkStore(new MemoryKv());
    await track(fakeSpotify(playback({ playlistId: null })), store, 1000);
    expect(await store.list()).toEqual([]);
  });

  it("skips the write while paused on the same spot", async () => {
    const kv = new MemoryKv();
    const store = new BookmarkStore(kv);
    await track(fakeSpotify(playback({ isPlaying: false })), store, 1000);
    const writes = kv.writes;

    await track(fakeSpotify(playback({ isPlaying: false })), store, 61000);

    expect(kv.writes).toBe(writes);
    expect((await store.get("gym"))?.updatedAt).toBe(1000);
  });

  it("recovers a playlist played between two polls from recently-played", async () => {
    const store = new BookmarkStore(new MemoryKv());
    const recent: RecentlyPlayedItem[] = [
      { trackUri: "spotify:track:s1", trackName: "Short 1", artistName: "X", playlistId: "short", playedAt: 5 * HOUR },
      { trackUri: "spotify:track:s2", trackName: "Short 2", artistName: "X", playlistId: "short", playedAt: 6 * HOUR },
    ];

    await track(fakeSpotify(null, recent), store, 7 * HOUR);

    expect(await store.get("short")).toMatchObject({ trackUri: "spotify:track:s2", positionMs: 0, updatedAt: 6 * HOUR });
  });

  it("does not let recently-played overwrite a newer or same-track bookmark", async () => {
    const store = new BookmarkStore(new MemoryKv());
    await track(fakeSpotify(playback()), store, 2 * HOUR);
    const recent: RecentlyPlayedItem[] = [
      { trackUri: "spotify:track:t11", trackName: "Older", artistName: "X", playlistId: "gym", playedAt: 1 * HOUR },
      { trackUri: "spotify:track:t12", trackName: "Thunderstruck", artistName: "AC/DC", playlistId: "gym", playedAt: 3 * HOUR },
    ];

    await track(fakeSpotify(null, recent), store, 4 * HOUR);

    expect(await store.get("gym")).toMatchObject({ trackUri: "spotify:track:t12", positionMs: 135000 });
  });
});

describe("saveCurrent", () => {
  it("returns null when no playlist is playing", async () => {
    expect(await saveCurrent(fakeSpotify(null), new BookmarkStore(new MemoryKv()), 1000)).toBeNull();
  });
});
