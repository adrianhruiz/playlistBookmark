import { describe, expect, it } from "vitest";
import { authorizeUrl, SpotifyClient, SpotifyNotConnectedError } from "../src/spotify";
import { fakeFetch, json, MemoryKv } from "./fakes";

const PLAYER = "GET https://api.spotify.com/v1/me/player";
const TOKEN = "POST https://accounts.spotify.com/api/token";

function connectedClient(routes: Parameters<typeof fakeFetch>[0]) {
  const kv = new MemoryKv();
  kv.data.set("spotify:refresh_token", "refresh-1");
  const fake = fakeFetch({ [TOKEN]: () => json({ access_token: "access-1", expires_in: 3600 }), ...routes });
  return { kv, ...fake, client: new SpotifyClient({ clientId: "id", clientSecret: "secret", kv, fetch: fake.fetch }) };
}

describe("authorizeUrl", () => {
  it("asks for the read and playback-control scopes", () => {
    const url = new URL(authorizeUrl("id", "https://bot.example/callback", "state-1"));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("https://bot.example/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("scope")).toContain("user-modify-playback-state");
    expect(url.searchParams.get("scope")).toContain("user-read-recently-played");
  });
});

describe("SpotifyClient", () => {
  it("connect stores the refresh token and caches the access token with a TTL", async () => {
    const kv = new MemoryKv();
    const { fetch, requests } = fakeFetch({
      [TOKEN]: () => json({ access_token: "access-1", expires_in: 3600, refresh_token: "refresh-1" }),
    });
    const client = new SpotifyClient({ clientId: "id", clientSecret: "secret", kv, fetch });

    await client.connect("code-1", "https://bot.example/callback");

    expect(await client.isConnected()).toBe(true);
    expect(kv.data.get("spotify:refresh_token")).toBe("refresh-1");
    expect(kv.data.get("spotify:access_token")).toBe("access-1");
    expect(kv.ttls.get("spotify:access_token")).toBe(3540);
    expect(requests[0]!.headers.get("Authorization")).toBe(`Basic ${btoa("id:secret")}`);
    expect(requests[0]!.body).toContain("grant_type=authorization_code");
    expect(requests[0]!.body).toContain("code=code-1");
  });

  it("throws SpotifyNotConnectedError without a refresh token", async () => {
    const client = new SpotifyClient({ clientId: "id", clientSecret: "secret", kv: new MemoryKv(), fetch: fakeFetch({}).fetch });
    await expect(client.getPlayback()).rejects.toBeInstanceOf(SpotifyNotConnectedError);
  });

  it("reads the playback of a playlist", async () => {
    const { client, requests } = connectedClient({
      [PLAYER]: () =>
        json({
          is_playing: true,
          progress_ms: 135000,
          item: { uri: "spotify:track:t12", name: "Thunderstruck", artists: [{ name: "AC/DC" }] },
          context: { type: "playlist", uri: "spotify:playlist:gym" },
          device: { name: "Pixel" },
        }),
    });

    expect(await client.getPlayback()).toEqual({
      isPlaying: true,
      progressMs: 135000,
      trackUri: "spotify:track:t12",
      trackName: "Thunderstruck",
      artistName: "AC/DC",
      playlistId: "gym",
      deviceName: "Pixel",
    });
    expect(requests.at(-1)!.headers.get("Authorization")).toBe("Bearer access-1");
  });

  it("returns null when nothing is playing", async () => {
    const { client } = connectedClient({ [PLAYER]: () => new Response(null, { status: 204 }) });
    expect(await client.getPlayback()).toBeNull();
  });

  it("returns a null playlist when the context is an album", async () => {
    const { client } = connectedClient({
      [PLAYER]: () =>
        json({
          is_playing: true,
          progress_ms: 1000,
          item: { uri: "spotify:track:a", name: "A", artists: [] },
          context: { type: "album", uri: "spotify:album:x" },
          device: null,
        }),
    });
    expect((await client.getPlayback())?.playlistId).toBeNull();
  });

  it("play sends the playlist, track and exact position", async () => {
    const { client, requests } = connectedClient({ "PUT https://api.spotify.com/v1/me/player/play": () => new Response(null, { status: 204 }) });

    expect(await client.play("gym", "spotify:track:t12", 135000)).toBe("ok");
    expect(JSON.parse(requests.at(-1)!.body)).toEqual({
      context_uri: "spotify:playlist:gym",
      offset: { uri: "spotify:track:t12" },
      position_ms: 135000,
    });
  });

  it("play reports premium_required on 403 PREMIUM_REQUIRED", async () => {
    const { client } = connectedClient({
      "PUT https://api.spotify.com/v1/me/player/play": () =>
        json({ error: { status: 403, message: "Premium required", reason: "PREMIUM_REQUIRED" } }, 403),
    });
    expect(await client.play("gym", "spotify:track:t12", 0)).toBe("premium_required");
  });

  it("play reports no_active_device on 404", async () => {
    const { client } = connectedClient({
      "PUT https://api.spotify.com/v1/me/player/play": () =>
        json({ error: { status: 404, message: "No active device", reason: "NO_ACTIVE_DEVICE" } }, 404),
    });
    expect(await client.play("gym", "spotify:track:t12", 0)).toBe("no_active_device");
  });
});
