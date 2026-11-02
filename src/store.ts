import type { KeyValue } from "./env";

export interface Bookmark {
  playlistId: string;
  playlistName: string;
  trackUri: string;
  trackName: string;
  artistName: string;
  positionMs: number;
  /** Epoch milliseconds of the last update. */
  updatedAt: number;
}

const BOOKMARK_PREFIX = "bookmark:";
const OWNER_KEY = "owner:chat_id";
const OAUTH_STATE_PREFIX = "oauth:state:";
const OAUTH_STATE_TTL_SECONDS = 600;

export class BookmarkStore {
  constructor(private readonly kv: KeyValue) {}

  async get(playlistId: string): Promise<Bookmark | null> {
    const raw = await this.kv.get(BOOKMARK_PREFIX + playlistId);
    return raw ? (JSON.parse(raw) as Bookmark) : null;
  }

  async save(bookmark: Bookmark): Promise<void> {
    await this.kv.put(BOOKMARK_PREFIX + bookmark.playlistId, JSON.stringify(bookmark));
  }

  /** All bookmarks, most recently updated first. */
  async list(): Promise<Bookmark[]> {
    const { keys } = await this.kv.list({ prefix: BOOKMARK_PREFIX });
    const ids = keys.map((key) => key.name.slice(BOOKMARK_PREFIX.length));
    const bookmarks = await Promise.all(ids.map((id) => this.get(id)));
    return bookmarks
      .filter((bookmark): bookmark is Bookmark => bookmark !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

export class OwnerStore {
  constructor(private readonly kv: KeyValue) {}

  async get(): Promise<number | null> {
    const raw = await this.kv.get(OWNER_KEY);
    return raw ? Number(raw) : null;
  }

  /** The first chat that claims the bot owns it; returns whether `chatId` is the owner. */
  async claim(chatId: number): Promise<boolean> {
    const owner = await this.get();
    if (owner === null) {
      await this.kv.put(OWNER_KEY, String(chatId));
      return true;
    }
    return owner === chatId;
  }

  async isOwner(chatId: number): Promise<boolean> {
    return (await this.get()) === chatId;
  }
}

export class OAuthStateStore {
  constructor(private readonly kv: KeyValue) {}

  async create(chatId: number): Promise<string> {
    const state = crypto.randomUUID();
    await this.kv.put(OAUTH_STATE_PREFIX + state, String(chatId), {
      expirationTtl: OAUTH_STATE_TTL_SECONDS,
    });
    return state;
  }

  /** Returns the chat that started the login and invalidates the state. */
  async consume(state: string): Promise<number | null> {
    const key = OAUTH_STATE_PREFIX + state;
    const raw = await this.kv.get(key);
    if (!raw) return null;
    await this.kv.delete(key);
    return Number(raw);
  }
}
