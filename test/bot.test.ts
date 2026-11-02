import { describe, expect, it } from "vitest";
import { handleUpdate, type BotDeps } from "../src/bot";
import { formatAgo, formatPosition } from "../src/format";
import { SpotifyNotConnectedError, type Playback, type PlayResult } from "../src/spotify";
import { BookmarkStore, OAuthStateStore, OwnerStore, type Bookmark } from "../src/store";
import type { InlineButton } from "../src/telegram";
import { MemoryKv } from "./fakes";

const OWNER = 42;
const NOW = 18 * 3_600_000;

interface Sent {
  chatId: number;
  text: string;
  buttons: InlineButton[][];
}

const gymBookmark: Bookmark = {
  playlistId: "gym",
  playlistName: "Gym Mix",
  trackUri: "spotify:track:t12",
  trackName: "Thunderstruck",
  artistName: "AC/DC",
  positionMs: 135000,
  updatedAt: 9 * 3_600_000,
};

const focusPlayback: Playback = {
  isPlaying: true,
  progressMs: 62000,
  trackUri: "spotify:track:f30",
  trackName: "Weightless",
  artistName: "Marconi Union",
  playlistId: "focus",
  deviceName: "MacBook",
};

async function setup(options: { playback?: Playback | null; playResult?: PlayResult; connected?: boolean; owner?: number | null } = {}) {
  const kv = new MemoryKv();
  const sent: Sent[] = [];
  const played: unknown[][] = [];
  const answered: string[] = [];
  const connected = options.connected ?? true;
  const ensureConnected = () => {
    if (!connected) throw new SpotifyNotConnectedError();
  };
  const deps: BotDeps = {
    spotify: {
      getPlayback: async () => (ensureConnected(), options.playback === undefined ? focusPlayback : options.playback),
      getRecentlyPlayed: async () => [],
      getPlaylistName: async (id) => (id === "focus" ? "Focus" : id),
      play: async (...args) => (ensureConnected(), played.push(args), options.playResult ?? "ok"),
    },
    telegram: {
      sendMessage: async (chatId, text, buttons = []) => void sent.push({ chatId, text, buttons }),
      answerCallbackQuery: async (id) => void answered.push(id),
    },
    bookmarks: new BookmarkStore(kv),
    owner: new OwnerStore(kv),
    oauthStates: new OAuthStateStore(kv),
    spotifyClientId: "client-id",
    baseUrl: "https://bot.example",
    now: NOW,
  };
  if (options.owner !== null) await deps.owner.claim(options.owner ?? OWNER);
  await deps.bookmarks.save(gymBookmark);
  return { kv, deps, sent, played, answered };
}

const text = (chatId: number, value: string, type = "private") => ({ message: { chat: { id: chatId, type }, text: value } });
const tap = (data: string) => ({ callback_query: { id: "cb-1", data, message: { chat: { id: OWNER } } } });

describe("format", () => {
  it("formats positions and elapsed time", () => {
    expect(formatPosition(135000)).toBe("2:15");
    expect(formatPosition(62000)).toBe("1:02");
    expect(formatAgo(30_000)).toBe("just now");
    expect(formatAgo(60_000)).toBe("1 min ago");
    expect(formatAgo(9 * 3_600_000)).toBe("9 h ago");
    expect(formatAgo(50 * 3_600_000)).toBe("2 d ago");
  });
});

describe("/start", () => {
  it("makes the first chat the owner and sends the Spotify login link", async () => {
    const { deps, sent, kv } = await setup({ owner: null });

    await handleUpdate(text(OWNER, "/start"), deps);

    expect(await deps.owner.get()).toBe(OWNER);
    expect(sent[0]!.text).toBe("Connect your Spotify");
    const button = sent[0]!.buttons[0]![0]! as { url: string };
    const url = new URL(button.url);
    expect(url.host).toBe("accounts.spotify.com");
    expect(url.searchParams.get("redirect_uri")).toBe("https://bot.example/callback");
    const state = url.searchParams.get("state")!;
    expect(kv.data.get(`oauth:state:${state}`)).toBe(String(OWNER));
  });

  it("only a private chat can claim the bot", async () => {
    const { deps, sent } = await setup({ owner: null });

    await handleUpdate(text(-100, "/start", "group"), deps);

    expect(sent).toEqual([]);
    expect(await deps.owner.get()).toBeNull();
  });

  it("ignores resume taps from a chat that is not the owner", async () => {
    const { deps, sent, played } = await setup();

    await handleUpdate({ callback_query: { id: "cb-2", data: "resume:gym", message: { chat: { id: 7 } } } }, deps);

    expect(played).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("ignores every chat that is not the owner", async () => {
    const { deps, sent } = await setup();

    await handleUpdate(text(7, "/start"), deps);
    await handleUpdate(text(7, "/resume"), deps);

    expect(sent).toEqual([]);
    expect(await deps.owner.get()).toBe(OWNER);
  });
});

describe("/resume", () => {
  it("saves the current playlist and lists bookmarks, newest first", async () => {
    const { deps, sent } = await setup();

    await handleUpdate(text(OWNER, "/resume"), deps);

    expect(sent[0]!.buttons).toEqual([
      [{ text: "Focus · Weightless, 1:02 · just now", callback_data: "resume:focus" }],
      [{ text: "Gym Mix · Thunderstruck, 2:15 · 9 h ago", callback_data: "resume:gym" }],
    ]);
  });

  it("tapping a playlist saves the current one at the exact second and resumes the chosen one (Premium)", async () => {
    const { deps, sent, played, answered } = await setup();

    await handleUpdate(tap("resume:gym"), deps);

    expect(answered).toEqual(["cb-1"]);
    expect(await deps.bookmarks.get("focus")).toMatchObject({ positionMs: 62000, updatedAt: NOW });
    expect(played).toEqual([["gym", "spotify:track:t12", 135000]]);
    expect(sent.at(-1)!.text).toBe("▶️ Resuming Gym Mix at 'Thunderstruck', 2:15");
  });

  it("without Premium tells where you were with an Open in Spotify link", async () => {
    const { deps, sent } = await setup({ playResult: "premium_required" });

    await handleUpdate(tap("resume:gym"), deps);

    expect(sent.at(-1)).toEqual({
      chatId: OWNER,
      text: "You were at 'Thunderstruck', 2:15 in Gym Mix",
      buttons: [[{ text: "Open in Spotify", url: "https://open.spotify.com/playlist/gym" }]],
    });
  });

  it("asks to open Spotify when there is no active device", async () => {
    const { deps, sent } = await setup({ playResult: "no_active_device" });

    await handleUpdate(tap("resume:gym"), deps);

    expect(sent.at(-1)!.text).toBe("Spotify is not open on any device. Open it, then tap Gym Mix again.");
  });
});

describe("/save and /now", () => {
  it("/save stores the current playlist at the exact second", async () => {
    const { deps, sent } = await setup();

    await handleUpdate(text(OWNER, "/save"), deps);

    expect(await deps.bookmarks.get("focus")).toMatchObject({ trackUri: "spotify:track:f30", positionMs: 62000 });
    expect(sent[0]!.text).toBe("💾 Saved Focus at 'Weightless', 1:02");
  });

  it("/save says so when no playlist is playing", async () => {
    const { deps, sent } = await setup({ playback: null });
    await handleUpdate(text(OWNER, "/save"), deps);
    expect(sent[0]!.text).toBe("Nothing to save: no playlist is playing.");
  });

  it("/now shows track, second and device", async () => {
    const { deps, sent } = await setup();

    await handleUpdate(text(OWNER, "/now"), deps);

    expect(sent[0]!.text).toBe("▶️ Weightless — Marconi Union\n1:02 · MacBook\nPlaylist: Focus");
  });

  it("asks to connect Spotify when it is not connected", async () => {
    const { deps, sent } = await setup({ connected: false });
    await handleUpdate(text(OWNER, "/now"), deps);
    expect(sent[0]!.text).toBe("Spotify is not connected. Send /start to connect it.");
  });

  it("answers unknown text with the command list", async () => {
    const { deps, sent } = await setup();
    await handleUpdate(text(OWNER, "hello"), deps);
    expect(sent[0]!.text).toContain("/resume");
  });
});
