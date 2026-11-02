export interface Env {
  KV: KVNamespace;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Public URL of the Worker, without trailing slash. */
  BASE_URL: string;
}

/** Subset of KVNamespace the app uses, so tests can pass an in-memory fake. */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

export type FetchFn = typeof fetch;
