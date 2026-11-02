import type { FetchFn, KeyValue } from "./env";

const ACCOUNTS_URL = "https://accounts.spotify.com";
const API_URL = "https://api.spotify.com/v1";
const REFRESH_TOKEN_KEY = "spotify:refresh_token";
const ACCESS_TOKEN_KEY = "spotify:access_token";

export const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-modify-playback-state",
];

export interface Playback {
  isPlaying: boolean;
  progressMs: number;
  trackUri: string;
  trackName: string;
  artistName: string;
  /** Set only when the playback context is a playlist. */
  playlistId: string | null;
  deviceName: string | null;
}

export interface RecentlyPlayedItem {
  trackUri: string;
  trackName: string;
  artistName: string;
  playlistId: string | null;
  /** Epoch milliseconds. */
  playedAt: number;
}

export type PlayResult = "ok" | "premium_required" | "no_active_device";

export class SpotifyError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export class SpotifyNotConnectedError extends Error {
  constructor() {
    super("Spotify is not connected");
  }
}

interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  kv: KeyValue;
  fetch?: FetchFn;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

interface SpotifyTrack {
  uri: string;
  name: string;
  artists?: { name: string }[];
}

interface SpotifyContext {
  type: string;
  uri: string;
}

export function playlistIdFromUri(uri: string): string | null {
  const match = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(uri);
  return match?.[1] ?? null;
}

function playlistIdFromContext(context: SpotifyContext | null | undefined): string | null {
  return context?.type === "playlist" ? playlistIdFromUri(context.uri) : null;
}

function artistNames(track: SpotifyTrack): string {
  return (track.artists ?? []).map((artist) => artist.name).join(", ");
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES.join(" "),
    state,
  });
  return `${ACCOUNTS_URL}/authorize?${params}`;
}

export class SpotifyClient {
  private readonly fetch: FetchFn;

  constructor(private readonly config: SpotifyConfig) {
    this.fetch = config.fetch ?? ((input, init) => fetch(input, init));
  }

  async isConnected(): Promise<boolean> {
    return (await this.config.kv.get(REFRESH_TOKEN_KEY)) !== null;
  }

  /** Completes the OAuth flow and stores the refresh token. */
  async connect(code: string, redirectUri: string): Promise<void> {
    await this.requestToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  async getPlayback(): Promise<Playback | null> {
    const response = await this.api("GET", "/me/player");
    if (response.status === 204) return null;
    const body = (await response.json()) as {
      is_playing: boolean;
      progress_ms: number | null;
      item: SpotifyTrack | null;
      context: SpotifyContext | null;
      device?: { name: string } | null;
    };
    // `item` is null during ads and other non-track playback.
    if (!body.item) return null;
    return {
      isPlaying: body.is_playing,
      progressMs: body.progress_ms ?? 0,
      trackUri: body.item.uri,
      trackName: body.item.name,
      artistName: artistNames(body.item),
      playlistId: playlistIdFromContext(body.context),
      deviceName: body.device?.name ?? null,
    };
  }

  async getRecentlyPlayed(limit = 20): Promise<RecentlyPlayedItem[]> {
    const response = await this.api("GET", `/me/player/recently-played?limit=${limit}`);
    const body = (await response.json()) as {
      items: { track: SpotifyTrack; played_at: string; context: SpotifyContext | null }[];
    };
    return body.items.map((item) => ({
      trackUri: item.track.uri,
      trackName: item.track.name,
      artistName: artistNames(item.track),
      playlistId: playlistIdFromContext(item.context),
      playedAt: Date.parse(item.played_at),
    }));
  }

  async getPlaylistName(playlistId: string): Promise<string> {
    const response = await this.api("GET", `/playlists/${playlistId}?fields=name`);
    const body = (await response.json()) as { name: string };
    return body.name;
  }

  /** Starts a playlist at a given track and position. Needs Premium and an active device. */
  async play(playlistId: string, trackUri: string, positionMs: number): Promise<PlayResult> {
    try {
      await this.api("PUT", "/me/player/play", {
        context_uri: `spotify:playlist:${playlistId}`,
        offset: { uri: trackUri },
        position_ms: positionMs,
      });
      return "ok";
    } catch (error) {
      if (error instanceof SpotifyError) {
        if (error.reason === "PREMIUM_REQUIRED") return "premium_required";
        if (error.reason === "NO_ACTIVE_DEVICE" || error.status === 404) return "no_active_device";
      }
      throw error;
    }
  }

  private async api(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.accessToken();
    const response = await this.fetch(`${API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        error?: { message?: string; reason?: string };
      } | null;
      throw new SpotifyError(
        response.status,
        error?.error?.reason,
        `Spotify ${method} ${path} failed: ${response.status} ${error?.error?.message ?? ""}`.trim(),
      );
    }
    return response;
  }

  private async accessToken(): Promise<string> {
    const cached = await this.config.kv.get(ACCESS_TOKEN_KEY);
    if (cached) return cached;
    const refreshToken = await this.config.kv.get(REFRESH_TOKEN_KEY);
    if (!refreshToken) throw new SpotifyNotConnectedError();
    return this.requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async requestToken(params: Record<string, string>): Promise<string> {
    const credentials = btoa(`${this.config.clientId}:${this.config.clientSecret}`);
    const response = await this.fetch(`${ACCOUNTS_URL}/api/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    });
    if (!response.ok) {
      throw new SpotifyError(response.status, undefined, `Spotify token request failed: ${response.status}`);
    }
    const token = (await response.json()) as TokenResponse;
    // Spotify may rotate the refresh token; keep the newest one.
    if (token.refresh_token) await this.config.kv.put(REFRESH_TOKEN_KEY, token.refresh_token);
    // KV requires a TTL of at least 60 s; expire a minute early to avoid using a stale token.
    await this.config.kv.put(ACCESS_TOKEN_KEY, token.access_token, {
      expirationTtl: Math.max(60, token.expires_in - 60),
    });
    return token.access_token;
  }
}
